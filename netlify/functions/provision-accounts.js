
const { createClient } = require('@supabase/supabase-js')
const crypto = require('crypto')

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

const digitsOnly = (s) => String(s || '').replace(/\D/g, '')

function normalizePhone(s) {
  let d = digitsOnly(s)
  if (d.length === 11 && d.startsWith('0')) {
    d = '234' + d.slice(1)
  }
  return d
}

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const looksLikeEmail = (s) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim())

function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const pick = (n) =>
    Array.from({ length: n }, () => A[crypto.randomInt(A.length)]).join('')

  return pick(4) + '-' + pick(4)
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' })
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    LOGIN_DOMAIN
  } = process.env

  // Default admission prefix for Alhaqq Schools.
  const PREFIX = process.env.ADMISSION_PREFIX || 'ANH'

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !LOGIN_DOMAIN) {
    return json(500, {
      error: 'The server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and LOGIN_DOMAIN in the Netlify environment variables, then redeploy.'
    })
  }

  const admin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  )

  // 1. Only school administrators may use this function.
  const token = String(
    event.headers.authorization ||
    event.headers.Authorization ||
    ''
  ).replace(/^Bearer\s+/i, '')

  if (!token) {
    return json(401, { error: 'Please sign in again.' })
  }

  const { data: who, error: whoError } =
    await admin.auth.getUser(token)

  if (whoError || !who || !who.user) {
    return json(401, {
      error: 'Your session has expired. Please sign in again.'
    })
  }

  const { data: member } = await admin
    .from('school_members')
    .select('school_id, role')
    .eq('user_id', who.user.id)
    .in('role', ['school_admin', 'super_admin'])
    .limit(1)
    .maybeSingle()

  if (!member) {
    return json(403, {
      error: 'Only school administrators can do this.'
    })
  }

  let body

  try {
    body = JSON.parse(event.body || '{}')
  } catch (e) {
    return json(400, { error: 'Bad request.' })
  }

  if (!body.studentId) {
    return json(400, { error: 'A student is required.' })
  }

  const { data: student, error: studentError } = await admin
    .from('students')
    .select(
      'id, school_id, surname, other_names, admission_number, admission_status, user_id'
    )
    .eq('id', body.studentId)
    .maybeSingle()

  if (studentError || !student) {
    return json(404, { error: 'Student not found.' })
  }

  if (
    student.school_id !== member.school_id &&
    member.role !== 'super_admin'
  ) {
    return json(403, {
      error: 'That student belongs to another school.'
    })
  }

  // Find an existing Supabase Auth user by email.
  async function findUserByEmail(email) {
    for (let page = 1; page <= 10; page++) {
      const { data, error } = await admin.auth.admin.listUsers({
        page,
        perPage: 1000
      })

      if (error || !data) return null

      const hit = data.users.find(
        u => (u.email || '').toLowerCase() === email.toLowerCase()
      )

      if (hit) return hit
      if (data.users.length < 1000) return null
    }

    return null
  }

  // Create a login or identify an existing account.
  async function createLogin({ email, fullName, role }) {
    const password = tempPassword()

    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        role,
        must_change_password: true
      }
    })

    if (created.error) {
      if (/already|registered|exists/i.test(created.error.message || '')) {
        const existing = await findUserByEmail(email)

        if (existing) {
          return {
            user: existing,
            password: null,
            existed: true
          }
        }
      }

      throw new Error(
        'Could not create the ' +
        role +
        ' login: ' +
        created.error.message
      )
    }

    return {
      user: created.data.user,
      password,
      existed: false
    }
  }

  // Register the account in the application's user and school tables.
  async function registerMember(user, fullName, email, role) {
    const { error: userError } = await admin
      .from('users')
      .upsert(
        {
          id: user.id,
          full_name: fullName,
          email,
          role
        },
        { onConflict: 'id' }
      )

    if (userError) {
      throw new Error(
        'Could not register the user profile: ' + userError.message
      )
    }

    const { data: has, error: memberError } = await admin
      .from('school_members')
      .select('user_id, role')
      .eq('user_id', user.id)
      .eq('school_id', student.school_id)
      .maybeSingle()

    if (memberError) {
      throw new Error(
        'Could not check school membership: ' + memberError.message
      )
    }

    if (!has) {
      const { error } = await admin
        .from('school_members')
        .insert({
          user_id: user.id,
          school_id: student.school_id,
          role
        })

      if (error) {
        throw new Error(
          'Could not register school membership: ' + error.message
        )
      }
    } else if (has.role === 'pending') {
      const { error } = await admin
        .from('school_members')
        .update({ role })
        .eq('user_id', user.id)
        .eq('school_id', student.school_id)

      if (error) {
        throw new Error(
          'Could not update school membership: ' + error.message
        )
      }
    }
  }

  // Internal email addresses used for phone-based parent logins.
  const parentLoginEmail = (p) =>
    looksLikeEmail(p.email)
      ? p.email.trim().toLowerCase()
      : 'p' + normalizePhone(p.phone) + '@' + LOGIN_DOMAIN

  const parentLoginId = (p) =>
    looksLikeEmail(p.email)
      ? p.email.trim().toLowerCase()
      : p.phone

  // Internal email address used for student admission-number logins.
  const studentLoginEmail = (adm) =>
    's-' + slug(adm) + '@' + LOGIN_DOMAIN

  async function linkedParent() {
    const { data: links, error } = await admin
      .from('student_parents')
      .select(
        'parent_id, parents(id, full_name, phone, email, user_id)'
      )
      .eq('student_id', student.id)
      .limit(1)

    if (error) {
      throw new Error(
        'Could not retrieve the parent record: ' + error.message
      )
    }

    return links && links[0] && links[0].parents
      ? links[0].parents
      : null
  }

  try {
    // --------------------------------------------------
    // RESET A LOGIN PASSWORD
    // --------------------------------------------------
    if (body.action === 'reset') {
      let userId = null
      let loginId = null
      let name = ''

      if (body.who === 'student') {
        userId = student.user_id
        loginId = student.admission_number
        name = [student.surname, student.other_names]
          .filter(Boolean)
          .join(' ')
      } else if (body.who === 'parent') {
        const p = await linkedParent()

        if (p) {
          userId = p.user_id
          loginId = parentLoginId(p)
          name = p.full_name
        }
      } else {
        return json(400, {
          error: 'Specify whether the password belongs to the student or parent.'
        })
      }

      if (!userId) {
        return json(404, {
          error: 'No login exists yet. Create the logins first.'
        })
      }

      const existing = await admin.auth.admin.getUserById(userId)

      if (existing.error || !existing.data || !existing.data.user) {
        return json(404, {
          error: 'The login account could not be found.'
        })
      }

      const password = tempPassword()

      const upd = await admin.auth.admin.updateUserById(userId, {
        password,
        user_metadata: {
          ...existing.data.user.user_metadata,
          must_change_password: true
        }
      })

      if (upd.error) {
        return json(500, {
          error: 'Could not reset the password: ' + upd.error.message
        })
      }

      return json(200, {
        ok: true,
        who: body.who,
        name,
        loginId,
        tempPassword: password
      })
    }

    // --------------------------------------------------
    // CREATE PARENT AND STUDENT LOGINS
    // --------------------------------------------------

    if (student.admission_status !== 'admitted') {
      return json(400, {
        error: 'Admit the student first, then create the logins.'
      })
    }

    // Assign an admission number only when one does not exist.
    let admissionNumber = student.admission_number

    if (!admissionNumber) {
      const { data: assigned, error: asgError } = await admin.rpc(
        'assign_admission_number',
        {
          p_student: student.id,
          p_prefix: PREFIX
        }
      )

      if (asgError) {
        throw new Error(
          'Could not assign an admission number: ' + asgError.message
        )
      }

      admissionNumber = assigned

      if (!admissionNumber) {
        throw new Error(
          'The database did not return an admission number.'
        )
      }
    }

    const studentName = [student.surname, student.other_names]
      .filter(Boolean)
      .join(' ')

    const result = {
      ok: true,
      studentName,
      admissionNumber,
      parent: null,
      studentLogin: null
    }

    // --------------------------------------------------
    // PARENT LOGIN
    // --------------------------------------------------

    let parent = await linkedParent()

    if (!parent && body.parent && body.parent.full_name && body.parent.phone) {
      const { data: np, error: npError } = await admin
        .from('parents')
        .insert({
          school_id: student.school_id,
          full_name: body.parent.full_name.trim(),
          phone: body.parent.phone.trim(),
          email: body.parent.email
            ? body.parent.email.trim().toLowerCase()
            : null
        })
        .select('id, full_name, phone, email, user_id')
        .single()

      if (npError) {
        throw new Error(
          'Could not save the parent: ' + npError.message
        )
      }

      const { error: linkError } = await admin
        .from('student_parents')
        .insert({
          student_id: student.id,
          parent_id: np.id
        })

      if (linkError) {
        throw new Error(
          'Could not link the parent to the student: ' +
          linkError.message
        )
      }

      parent = np
    }

    if (!parent) {
      result.parent = { status: 'no_parent' }
    } else if (parent.user_id) {
      result.parent = {
        status: 'existing',
        name: parent.full_name,
        phone: parent.phone,
        loginId: parentLoginId(parent)
      }
    } else if (
      normalizePhone(parent.phone).length < 10 &&
      !looksLikeEmail(parent.email)
    ) {
      result.parent = {
        status: 'no_contact',
        name: parent.full_name
      }
    } else {
      const email = parentLoginEmail(parent)

      const made = await createLogin({
        email,
        fullName: parent.full_name,
        role: 'parent'
      })

      await registerMember(
        made.user,
        parent.full_name,
        email,
        'parent'
      )

      const { error: parentUpdateError } = await admin
        .from('parents')
        .update({ user_id: made.user.id })
        .eq('id', parent.id)

      if (parentUpdateError) {
        throw new Error(
          'Could not link the parent login: ' +
          parentUpdateError.message
        )
      }

      result.parent = {
        status: made.existed ? 'adopted' : 'created',
        name: parent.full_name,
        phone: parent.phone,
        loginId: parentLoginId(parent),
        tempPassword: made.password
      }
    }

    // --------------------------------------------------
    // STUDENT LOGIN
    // --------------------------------------------------

    if (body.createStudentLogin !== false) {
      if (student.user_id) {
        result.studentLogin = {
          status: 'existing',
          loginId: admissionNumber
        }
      } else {
        const email = studentLoginEmail(admissionNumber)

        const made = await createLogin({
          email,
          fullName: studentName,
          role: 'student'
        })

        await registerMember(
          made.user,
          studentName,
          email,
          'student'
        )

        const { error: studentUpdateError } = await admin
          .from('students')
          .update({ user_id: made.user.id })
          .eq('id', student.id)

        if (studentUpdateError) {
          throw new Error(
            'Could not link the student login: ' +
            studentUpdateError.message
          )
        }

        result.studentLogin = {
          status: made.existed ? 'adopted' : 'created',
          loginId: admissionNumber,
          tempPassword: made.password
        }
      }
    }

    return json(200, result)
  } catch (err) {
    console.error('Student login function error:', err)

    return json(500, {
      error: err.message || 'Something went wrong.'
    })
  }
}
