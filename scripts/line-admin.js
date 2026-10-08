// Explicit operations only. No account or line is seeded by migrations.
const fs=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {databaseOptions}=require('./database-options');
async function main(args=process.argv.slice(2)) {
  const local=args.includes('--local');
  const envIndex=args.indexOf('--env');
  if (!local && envIndex<0) throw new Error('Indica --local o --env ARCHIVO. Nunca se carga .env automáticamente.');
  if (local && envIndex>=0) throw new Error('Elige solo un entorno.');
  if (args.includes('--migrate') && !local) throw new Error('--migrate solo está disponible con --local.');
  let configuration;
  if (local) {
    const secrets=JSON.parse(fs.readFileSync(path.join(__dirname,'../.local/secrets.json'),'utf8'));
    configuration={connectionString:`postgresql://transit_local:${secrets.db}@127.0.0.1:55432/transit_local`,ssl:false};
  } else {
    const file=args[envIndex+1];if(!file)throw new Error('Falta el archivo de entorno.');
    const values=require('dotenv').parse(fs.readFileSync(path.resolve(file)));
    configuration=databaseOptions({...values,NODE_ENV:"production"});
    if(!configuration.connectionString)throw new Error('Falta DATABASE_URL en el archivo indicado.');
  }
  const pool=new Pool({...configuration,connectionTimeoutMillis:5000});
  const promote=args.indexOf('--promote');
  try {
    if (args.includes('--migrate')) {
      const client=await pool.connect();
      try {
        await require('./migration-runner').migrate(client,path.join(__dirname,'../src/db/migrations'));
      } finally {client.release();}
    }
    const schema=await pool.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='admins' AND column_name='is_superadmin') AS ready`);
    if (!schema.rows[0].ready) {
      throw new Error('Falta aplicar 013_line_tenancy.sql. '+(local
        ? 'Repite el comando añadiendo --migrate, o reinicia node scripts/dev-local.js.'
        : 'Aplica las migraciones del backend al entorno indicado antes de continuar.'));
    }
    if (promote>=0) {
      const email=args[promote+1]?.trim().toLowerCase();if(!email||!email.includes('@'))throw new Error('Falta el correo de la cuenta existente.');
      const result=await pool.query("UPDATE admins SET is_superadmin=true,token_version=token_version+1 WHERE email=$1 AND status='active' RETURNING id",[email]);
      if(!result.rows.length)throw new Error('No existe una cuenta administrativa activa con ese correo.');
      console.log('Cuenta designada superadministrador. Cierra sesión y vuelve a entrar.');
    } else if(args.includes('--finalize')) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE routes,fleet_vehicles IN ACCESS EXCLUSIVE MODE');
        const remaining=await client.query('SELECT (SELECT count(*) FROM routes WHERE transport_line_id IS NULL)+(SELECT count(*) FROM fleet_vehicles WHERE transport_line_id IS NULL) AS n');
        if(Number(remaining.rows[0].n)>0)throw new Error('Quedan rutas o camiones sin línea. Completa la asignación antes de finalizar.');
        await client.query('ALTER TABLE routes ALTER COLUMN transport_line_id SET NOT NULL');
        await client.query('ALTER TABLE fleet_vehicles ALTER COLUMN transport_line_id SET NOT NULL');
        await client.query('ALTER TABLE driver_sessions VALIDATE CONSTRAINT session_route_line_fk');
        await client.query('COMMIT');console.log('Propiedad de rutas/camiones obligatoria e integridad histórica validada.');
      } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    } else {
      const result=await pool.query(`SELECT
        (SELECT count(*) FROM admins WHERE is_superadmin AND status='active') AS superadmins,
        (SELECT count(*) FROM routes WHERE transport_line_id IS NULL) AS unassigned_routes,
        (SELECT count(*) FROM fleet_vehicles WHERE transport_line_id IS NULL) AS unassigned_vehicles,
        (SELECT count(*) FROM conductores c WHERE NOT EXISTS(SELECT 1 FROM driver_line_memberships m WHERE m.conductor_id=c.id)) AS unassigned_drivers,
        (SELECT count(*) FROM driver_sessions s JOIN routes r ON r.id=s.route_id WHERE s.transport_line_id IS NOT NULL AND s.transport_line_id IS DISTINCT FROM r.transport_line_id) AS sessions_needing_review,
        (SELECT count(*) FROM driver_sessions WHERE transport_line_id IS NULL) AS sessions_without_line`);
      console.log(JSON.stringify(result.rows[0],null,2));
    }
  } finally {await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
