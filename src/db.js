const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'fixmitra.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.transaction = function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result=fn(...args); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
};

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customer_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      building TEXT, street TEXT, city TEXT, state TEXT, pincode TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS service_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL, image TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL,
      inclusions TEXT NOT NULL, instructions TEXT NOT NULL, duration TEXT NOT NULL,
      starting_price INTEGER NOT NULL CHECK(starting_price >= 0),
      inspection_fee INTEGER NOT NULL DEFAULT 0 CHECK(inspection_fee >= 0),
      discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
      image TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, is_demo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS technicians (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      specialization TEXT NOT NULL, experience INTEGER NOT NULL DEFAULT 0,
      service_areas TEXT NOT NULL, availability TEXT NOT NULL DEFAULT 'Available',
      active INTEGER NOT NULL DEFAULT 1, image TEXT, is_demo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
      building TEXT NOT NULL, street TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, pincode TEXT NOT NULL,
      problem TEXT NOT NULL, appointment_date TEXT NOT NULL, appointment_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New','Contacted','Quoted','Confirmed','Technician Assigned','In Progress','Completed','Cancelled')),
      technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
      internal_notes TEXT, submission_token TEXT UNIQUE, is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(appointment_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_service ON bookings(service_id);
    CREATE TABLE IF NOT EXISTS booking_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      status TEXT NOT NULL, note TEXT, changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      labour INTEGER NOT NULL DEFAULT 0, materials INTEGER NOT NULL DEFAULT 0,
      additional INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Sent','Accepted','Declined')),
      notes TEXT, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      company_name TEXT NOT NULL, business_email TEXT NOT NULL, business_phone TEXT,
      service_area TEXT NOT NULL, operating_hours TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
      booking_notice TEXT NOT NULL, email_notifications INTEGER NOT NULL DEFAULT 0,
      whatsapp_notifications INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role TEXT, title TEXT NOT NULL, message TEXT NOT NULL, booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
      read_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, subject TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'New', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO admin_settings
    (id,company_name,business_email,business_phone,service_area,operating_hours,currency,booking_notice)
    VALUES (1,'FixMitra','Business@Supportfix.com',NULL,'Around Turkey','Monday–Saturday, 09:00–18:00','INR','Final quotations may vary after inspection of the work required.')`).run();
}

const categories = [
  ['Plumbing','plumbing','Leaks, fixtures and water-system care.','/images/service-plumbing.webp'],
  ['Electrical Repairs','electrical','Safe troubleshooting, fittings and repairs.','/images/service-electrical.webp'],
  ['AC Installation & Servicing','ac-servicing','Installation, cleaning and cooling diagnostics.','/images/service-ac.webp'],
  ['Home Cleaning','home-cleaning','Detailed care for healthier living spaces.','/images/service-cleaning.webp'],
  ['Carpentry','carpentry','Furniture, cabinetry and fitting repairs.','/images/service-carpentry.webp'],
  ['Painting','painting','Interior consultation and professional finishes.','/images/service-painting.webp'],
  ['Appliance Repair','appliance-repair','Diagnosis and repair for household appliances.','/images/service-appliance.webp'],
  ['General Home Maintenance','general-maintenance','Everyday repairs and preventive maintenance.','/images/service-maintenance.webp']
];
const serviceRows = [
  ['plumbing','Plumbing Inspection','plumbing-inspection','Professional diagnosis for leaks, pressure problems and fixture issues.','Issue inspection|Minor adjustment|Written work recommendation','Please ensure the affected area is accessible.','45–60 min',199],
  ['plumbing','Tap & Fixture Repair','tap-fixture-repair','Repair or replacement support for household taps and fixtures.','Initial diagnosis|Basic fitting work|Area cleanup','Replacement parts are quoted separately.','60–90 min',349],
  ['electrical','Electrical Inspection','electrical-inspection','Safety-focused inspection for switches, sockets and circuit concerns.','Safety inspection|Fault diagnosis|Repair recommendation','Keep the main distribution board accessible.','45–60 min',199],
  ['electrical','Switch & Socket Repair','switch-socket-repair','Repair support for loose, damaged or non-working switches and sockets.','Electrical diagnosis|Basic repair|Safety check','Materials are charged only after approval.','60–90 min',299],
  ['ac-servicing','AC Servicing','ac-servicing-standard','Preventive split-AC cleaning and performance check.','Filter cleaning|Coil inspection|Cooling check|Drain check','Provide clear access to the indoor and outdoor units.','60–90 min',599],
  ['ac-servicing','AC Installation Consultation','ac-installation-consultation','Site assessment for safe, efficient AC installation.','Location assessment|Capacity guidance|Installation estimate','Equipment and installation are quoted separately.','45–60 min',399],
  ['home-cleaning','Bathroom Deep Cleaning','bathroom-deep-cleaning','Detailed cleaning for tiles, fittings and sanitary surfaces.','Surface cleaning|Fixture care|Floor treatment','Please remove personal items before the visit.','90–120 min',799],
  ['home-cleaning','Home Deep Cleaning','home-deep-cleaning','Comprehensive cleaning plan for occupied homes.','Room-by-room cleaning|Kitchen surfaces|Bathrooms|Floors','Price varies with property size and condition.','4–8 hours',1499],
  ['carpentry','Carpentry Service','carpentry-service','Skilled support for doors, cabinets and furniture repairs.','Inspection|Minor adjustment|Work estimate','Special materials are quoted separately.','60–120 min',399],
  ['painting','Painting Consultation','painting-consultation','On-site color, surface and project-scope consultation.','Surface assessment|Color guidance|Project estimate','Painting labour and material are quoted separately.','45–60 min',299],
  ['appliance-repair','Appliance Diagnosis','appliance-diagnosis','Diagnosis for washing machines, refrigerators and common appliances.','Safety check|Fault diagnosis|Repair estimate','Share the appliance make and model in your request.','45–75 min',349],
  ['general-maintenance','Home Maintenance Visit','home-maintenance-visit','A flexible visit for small repairs and preventive checks.','Priority inspection|Minor adjustments|Maintenance plan','List all issues in the booking description.','60–120 min',449]
];
const demoNames = ['Aarav Mehta','Diya Nair','Kabir Shah','Meera Iyer','Rohan Gupta','Sara Khan','Vivaan Rao','Anaya Singh','Arjun Das','Ishita Patel'];
const techRows = [
  ['Emre Kaya','9876500011','emre.kaya@example.test','AC & Appliance Repair',8],
  ['Selin Yılmaz','9876500012','selin.yilmaz@example.test','Home Cleaning',6],
  ['Murat Demir','9876500013','murat.demir@example.test','Plumbing',10],
  ['Aylin Arslan','9876500014','aylin.arslan@example.test','Electrical Repairs',7],
  ['Can Özkan','9876500015','can.ozkan@example.test','Carpentry & Maintenance',9],
  ['Deniz Çelik','9876500016','deniz.celik@example.test','Painting',5]
];

function seedDemo({ force = false } = {}) {
  const seed = db.transaction(() => {
    if (force) {
      db.exec('DELETE FROM notifications; DELETE FROM reviews; DELETE FROM quotations; DELETE FROM booking_status_history; DELETE FROM bookings WHERE is_demo=1; DELETE FROM technicians WHERE is_demo=1; DELETE FROM services WHERE is_demo=1; DELETE FROM customer_profiles WHERE is_demo=1; DELETE FROM users WHERE role=\'customer\' AND email LIKE \'%@example.test\';');
    }
    if (!db.prepare('SELECT id FROM service_categories LIMIT 1').get()) {
      const stmt = db.prepare('INSERT INTO service_categories(name,slug,description,image,sort_order) VALUES (?,?,?,?,?)');
      categories.forEach((c,i)=>stmt.run(...c,i));
    }
    if (!db.prepare('SELECT id FROM services LIMIT 1').get()) {
      const cat = Object.fromEntries(db.prepare('SELECT slug,id FROM service_categories').all().map(x=>[x.slug,x.id]));
      const stmt = db.prepare(`INSERT INTO services(category_id,name,slug,description,inclusions,instructions,duration,starting_price,image)
        VALUES (?,?,?,?,?,?,?,?,(SELECT image FROM service_categories WHERE id=?))`);
      serviceRows.forEach(s=>stmt.run(cat[s[0]],...s.slice(1),cat[s[0]]));
    }
    if (!db.prepare('SELECT id FROM technicians LIMIT 1').get()) {
      const stmt = db.prepare(`INSERT INTO technicians(name,phone,email,specialization,experience,service_areas,image)
        VALUES (?,?,?,?,?,'Around Turkey',?)`);
      techRows.forEach((t,i)=>stmt.run(...t,`/images/technician-${(i%3)+1}.svg`));
    }
    const demoPassword = crypto.randomUUID();
    const hash = hashPassword(demoPassword);
    const addUser = db.prepare(`INSERT OR IGNORE INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?, 'customer')`);
    const addProfile = db.prepare(`INSERT OR IGNORE INTO customer_profiles(user_id,building,street,city,state,pincode,is_demo) VALUES (?,?,?,?,?,?,1)`);
    demoNames.forEach((name,i)=>{
      addUser.run(name,`demo.customer${i+1}@example.test`,`9${String(876500000+i).padStart(9,'0')}`,hash);
      const u=db.prepare('SELECT id FROM users WHERE email=?').get(`demo.customer${i+1}@example.test`);
      addProfile.run(u.id,`${i+1} Demo Residence`,'Sample Street','Istanbul','Istanbul',`4000${i}`);
    });
    if (!db.prepare('SELECT id FROM bookings WHERE is_demo=1 LIMIT 1').get()) {
      const services=db.prepare('SELECT id FROM services ORDER BY id').all();
      const users=db.prepare("SELECT id,name,email,phone FROM users WHERE email LIKE '%@example.test' ORDER BY id LIMIT 10").all();
      const techs=db.prepare('SELECT id FROM technicians WHERE is_demo=1 ORDER BY id').all();
      const statuses=['New','Contacted','Quoted','Confirmed','Technician Assigned','In Progress','Completed','Cancelled'];
      const addBooking=db.prepare(`INSERT INTO bookings(reference,user_id,service_id,customer_name,phone,email,building,street,city,state,pincode,problem,appointment_date,appointment_time,status,technician_id,is_demo,created_at)
        VALUES (?,?,?,?,?,?,'Demo Residence','Sample Street','Istanbul','Istanbul','400001',?,?,?,?,?,1,datetime('now',?))`);
      const addHistory=db.prepare('INSERT INTO booking_status_history(booking_id,status,note,created_at) VALUES (?,?,?,datetime(\'now\',?))');
      for(let i=0;i<20;i++){
        const u=users[i%users.length], svc=services[i%services.length], status=statuses[i%statuses.length];
        const ref=`FM-DEMO-${String(i+1).padStart(4,'0')}`;
        const appt=new Date(Date.now()+(i-8)*86400000).toISOString().slice(0,10);
        const tech=['Technician Assigned','In Progress','Completed'].includes(status)?techs[i%techs.length].id:null;
        const info=addBooking.run(ref,u.id,svc.id,u.name,u.phone,u.email,`Demonstration request ${i+1}: inspect and provide an estimate.`,appt,i%2?'14:00':'10:00',status,tech,`-${20-i} days`);
        addHistory.run(info.lastInsertRowid,'New','Demonstration booking created.',`-${20-i} days`);
        if(status!=='New') addHistory.run(info.lastInsertRowid,status,'Demonstration status update.',`-${Math.max(0,18-i)} days`);
        if(['Quoted','Confirmed','Technician Assigned','In Progress','Completed'].includes(status)) {
          const labour=500+i*25, materials=200+i*10, additional=50, discount=i%3?0:100, total=labour+materials+additional-discount;
          db.prepare(`INSERT INTO quotations(booking_id,labour,materials,additional,discount,total,status,notes) VALUES (?,?,?,?,?,?,'Sent','Illustrative demonstration quotation—not a payment receipt.')`).run(info.lastInsertRowid,labour,materials,additional,discount,total);
        }
        if(status==='Completed' && i<10) db.prepare(`INSERT OR IGNORE INTO reviews(booking_id,user_id,rating,comment,published,is_demo) VALUES (?,?,5,'Professional and well-organized demonstration experience.',1,1)`).run(info.lastInsertRowid,u.id);
      }
    }
  });
  seed();
}

function bootstrapAdmin(email, password, name='FixMitra Administrator') {
  if (!email || !password || password.length < 12) throw new Error('ADMIN_EMAIL and a password of at least 12 characters are required.');
  const hash=hashPassword(password);
  db.prepare(`INSERT INTO users(name,email,password_hash,role,active) VALUES (?,?,?,'admin',1)
    ON CONFLICT(email) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='admin',active=1,updated_at=CURRENT_TIMESTAMP`).run(name,email.toLowerCase(),hash);
}

migrate();
seedDemo();
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) bootstrapAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, process.env.ADMIN_NAME);

module.exports = { db, dbFile, migrate, seedDemo, bootstrapAdmin };
