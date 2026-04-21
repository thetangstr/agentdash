import pg from 'pg';
import { homedir } from 'os';
const socket = homedir() + '/.paperclip/instances/default/db/.s.PGSQL.5433';
const pool = new pg.Pool({ host: socket, database: 'paperclip', user: process.env.USER });
try {
  const users = await pool.query('SELECT id, email, name FROM "user"');
  console.log('Users:', JSON.stringify(users.rows));
  if (users.rows.length > 0) {
    const userId = users.rows[0].id;
    console.log('Making user', userId, 'instance admin...');
    await pool.query(`INSERT INTO instance_user_roles (id, user_id, role) VALUES (gen_random_uuid(), $1, 'instance_admin') ON CONFLICT DO NOTHING`, [userId]);
    console.log('Done. Now checking companies...');
    const companies = await pool.query('SELECT id, name, issue_prefix FROM companies');
    console.log('Companies:', JSON.stringify(companies.rows));
    if (companies.rows.length > 0) {
      for (const c of companies.rows) {
        await pool.query(`INSERT INTO company_memberships (id, company_id, principal_type, principal_id, role, status) VALUES (gen_random_uuid(), $1, 'user', $2, 'owner', 'active') ON CONFLICT DO NOTHING`, [c.id, userId]);
        console.log('Added membership for', c.name);
      }
    }
  }
} finally { await pool.end(); }
