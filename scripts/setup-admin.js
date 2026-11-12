const {bootstrapAdmin}=require('../src/db');
const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD,name=process.env.ADMIN_NAME||'FixMitra Administrator';
try{bootstrapAdmin(email,password,name);console.log(`Administrator account created or updated for ${email}.`)}catch(e){console.error(e.message);console.error('Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD="a-strong-12+-character-password" npm run setup-admin');process.exit(1)}
