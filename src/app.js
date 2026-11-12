const { express, session, helmet, rateLimit, multer } = require('./platform');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { hashPassword, verifyPassword } = require('./auth');
const { db, seedDemo } = require('./db');
const h = require('./helpers');

class SqliteStore extends session.Store {
  constructor(database){super();this.db=database;this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);`)}
  get(sid,cb){try{this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());const row=this.db.prepare('SELECT sess FROM sessions WHERE sid=?').get(sid);cb(null,row?JSON.parse(row.sess):null)}catch(e){cb(e)}}
  set(sid,sess,cb=()=>{}){try{const expires=sess.cookie?.expires?new Date(sess.cookie.expires).getTime():Date.now()+8*60*60*1000;this.db.prepare('INSERT INTO sessions(sid,sess,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expires=excluded.expires').run(sid,JSON.stringify(sess),expires);cb()}catch(e){cb(e)}}
  destroy(sid,cb=()=>{}){try{this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);cb()}catch(e){cb(e)}}
  touch(sid,sess,cb=()=>{}){try{const expires=sess.cookie?.expires?new Date(sess.cookie.expires).getTime():Date.now()+8*60*60*1000;this.db.prepare('UPDATE sessions SET expires=? WHERE sid=?').run(expires,sid);cb()}catch(e){cb(e)}}
}

const app = express();
const root = path.join(__dirname,'..');
const uploadDir = process.env.UPLOAD_DIR || path.join(root,'public','uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const upload = multer({
  storage: multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,`${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)}),
  limits:{fileSize:2*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))
});

app.set('view engine','ejs'); app.set('views',path.join(root,'views')); app.set('trust proxy',1); app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],imgSrc:["'self'",'data:'],styleSrc:["'self'"],scriptSrc:["'self'"],fontSrc:["'self'"],formAction:["'self'"],frameAncestors:["'none'"]}}}));
app.use(express.urlencoded({extended:false,limit:'50kb'}));
app.use(express.json({limit:'50kb'}));
app.use(express.static(path.join(root,'public'),{maxAge:process.env.NODE_ENV==='production'?'7d':0,etag:true}));
app.use(session({
  store:new SqliteStore(db),
  secret:process.env.SESSION_SECRET || (process.env.NODE_ENV==='production'?(()=>{throw new Error('SESSION_SECRET is required in production')})():'development-only-secret-change-me'),
  name:'fixmitra.sid',resave:false,saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:1000*60*60*8}
}));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:15,standardHeaders:'draft-7',legacyHeaders:false,message:'Too many attempts. Please try again later.'});
const formLimiter=rateLimit({windowMs:10*60*1000,limit:40,standardHeaders:'draft-7',legacyHeaders:false});

app.use((req,res,next)=>{
  if(!req.session.csrf) req.session.csrf=crypto.randomBytes(24).toString('hex');
  res.locals.csrf=req.session.csrf;
  res.locals.user=req.session.user||null;
  res.locals.path=req.path;
  res.locals.flash=req.session.flash||null; delete req.session.flash;
  res.locals.settings=db.prepare('SELECT * FROM admin_settings WHERE id=1').get();
  res.locals.h=h;
  res.locals.currentYear=new Date().getFullYear();
  next();
});
app.use((req,res,next)=>{
  if(['POST','PUT','PATCH','DELETE'].includes(req.method) && (!req.body || req.body._csrf!==req.session.csrf)) return res.status(403).render('error',{title:'Request expired',status:403,message:'Please return to the previous page, refresh it and try again.'});
  next();
});
function customerOnly(req,res,next){if(!req.session.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`); if(req.session.user.role!=='customer') return res.status(403).render('error',{title:'Access denied',status:403,message:'This page is available to customers only.'}); next();}
function adminOnly(req,res,next){if(!req.session.user) return res.redirect('/admin/login'); if(req.session.user.role!=='admin') return res.status(403).render('error',{title:'Access denied',status:403,message:'Administrator authorization is required.'}); next();}
function notify({userId=null,role=null,title,message,bookingId=null}){db.prepare('INSERT INTO notifications(user_id,role,title,message,booking_id) VALUES (?,?,?,?,?)').run(userId,role,title,message,bookingId);}
function safeNext(value,fallback='/dashboard'){const v=String(value||'');return v.startsWith('/')&&!v.startsWith('//')?v:fallback;}

app.get('/',(req,res)=>{
  const services=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 AND c.active=1 ORDER BY c.sort_order,s.id LIMIT 8`).all();
  const techs=db.prepare('SELECT * FROM technicians WHERE active=1 ORDER BY id LIMIT 3').all();
  const reviews=db.prepare(`SELECT r.*,u.name,s.name service_name FROM reviews r JOIN users u ON u.id=r.user_id JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id WHERE r.published=1 ORDER BY r.created_at DESC LIMIT 3`).all();
  res.render('home',{title:'Reliable Home Services. Simplified.',services,techs,reviews});
});
app.get('/about',(req,res)=>res.render('about',{title:'About FixMitra'}));
app.get('/privacy',(req,res)=>res.render('legal',{title:'Privacy Policy',kind:'privacy'}));
app.get('/terms',(req,res)=>res.render('legal',{title:'Terms & Conditions',kind:'terms'}));
app.get('/services',(req,res)=>{
  const q=h.clean(req.query.q,100), category=h.clean(req.query.category,60);
  const where=['s.active=1','c.active=1'],params=[];
  if(q){where.push('(s.name LIKE ? OR s.description LIKE ? OR c.name LIKE ?)');params.push(`%${q}%`,`%${q}%`,`%${q}%`)}
  if(category){where.push('c.slug=?');params.push(category)}
  const services=db.prepare(`SELECT s.*,c.name category_name,c.slug category_slug FROM services s JOIN service_categories c ON c.id=s.category_id WHERE ${where.join(' AND ')} ORDER BY c.sort_order,s.name`).all(...params);
  const categories=db.prepare('SELECT * FROM service_categories WHERE active=1 ORDER BY sort_order').all();
  res.render('services',{title:'Professional Home Services',services,categories,q,category});
});
app.get('/services/:slug',(req,res)=>{
  const service=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.slug=? AND s.active=1`).get(req.params.slug);
  if(!service)return res.status(404).render('error',{title:'Service not found',status:404,message:'This service is unavailable or does not exist.'});
  const related=db.prepare('SELECT * FROM services WHERE category_id=? AND id<>? AND active=1 LIMIT 3').all(service.category_id,service.id);
  res.render('service-detail',{title:service.name,service,related});
});
app.get('/book',(req,res)=>{
  const services=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 ORDER BY c.sort_order,s.name`).all();
  req.session.bookingToken=crypto.randomUUID();
  const selected=Number(req.query.service)||null;
  const profile=req.session.user?db.prepare(`SELECT u.name,u.email,u.phone,p.* FROM users u LEFT JOIN customer_profiles p ON p.user_id=u.id WHERE u.id=?`).get(req.session.user.id):{};
  res.render('book',{title:'Book a Service',services,selected,profile,bookingToken:req.session.bookingToken,minDate:new Date(Date.now()+86400000).toISOString().slice(0,10),errors:{},values:{}});
});
app.post('/book',formLimiter,(req,res)=>{
  const fields=['service_id','problem','customer_name','phone','email','building','street','city','state','pincode','appointment_date','appointment_time'];
  const v=Object.fromEntries(fields.map(k=>[k,h.clean(req.body[k],k==='problem'?2000:254)]));
  const errors={}; const service=db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(Number(v.service_id));
  if(!service)errors.service_id='Choose an available service.'; if(v.problem.length<15)errors.problem='Describe the issue in at least 15 characters.'; if(v.customer_name.length<2)errors.customer_name='Enter your full name.';
  if(!h.phone(v.phone))errors.phone='Enter a valid 10-digit Indian mobile number.'; if(v.email&&!h.email(v.email))errors.email='Enter a valid email address.';
  ['building','street','city','state'].forEach(k=>{if(v[k].length<2)errors[k]='This field is required.'}); if(!h.pincode(v.pincode))errors.pincode='Enter a valid 6-digit PIN code.';
  if(!h.isFutureDate(v.appointment_date))errors.appointment_date='Choose today or a future date.'; if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.appointment_time))errors.appointment_time='Choose a preferred time.';
  if(req.body.submission_token!==req.session.bookingToken) errors.form='This form has expired. Refresh and try again.';
  if(Object.keys(errors).length){const services=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 ORDER BY c.sort_order,s.name`).all(); return res.status(422).render('book',{title:'Book a Service',services,selected:Number(v.service_id),profile:{},bookingToken:req.session.bookingToken,minDate:new Date().toISOString().slice(0,10),errors,values:v});}
  const existing=db.prepare('SELECT * FROM bookings WHERE submission_token=?').get(req.body.submission_token); if(existing)return res.redirect(`/booking-success/${existing.reference}`);
  let ref; do {ref=h.bookingRef()} while(db.prepare('SELECT id FROM bookings WHERE reference=?').get(ref));
  const info=db.transaction(()=>{
    const result=db.prepare(`INSERT INTO bookings(reference,user_id,service_id,customer_name,phone,email,building,street,city,state,pincode,problem,appointment_date,appointment_time,submission_token)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref,req.session.user?.role==='customer'?req.session.user.id:null,service.id,v.customer_name,h.phone(v.phone),v.email?h.email(v.email):null,v.building,v.street,v.city,v.state,h.pincode(v.pincode),v.problem,v.appointment_date,v.appointment_time,req.body.submission_token);
    db.prepare("INSERT INTO booking_status_history(booking_id,status,note) VALUES (?,'New','Service request submitted and awaiting administrator review.')").run(result.lastInsertRowid);
    notify({role:'admin',title:'New booking submitted',message:`${ref} requires review.`,bookingId:result.lastInsertRowid});
    if(req.session.user?.role==='customer')notify({userId:req.session.user.id,title:'Booking received',message:`${ref} was submitted with status New.`,bookingId:result.lastInsertRowid});
    return result.lastInsertRowid;
  })();
  req.session.lastBooking={id:info,reference:ref,phone:h.phone(v.phone)}; delete req.session.bookingToken; res.redirect(`/booking-success/${ref}`);
});
app.get('/booking-success/:reference',(req,res)=>{
  const allowed=req.session.lastBooking?.reference===req.params.reference || (req.session.user&&db.prepare('SELECT id FROM bookings WHERE reference=? AND user_id=?').get(req.params.reference,req.session.user.id));
  if(!allowed)return res.redirect('/track');
  const booking=db.prepare(`SELECT b.*,s.name service_name FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.reference=?`).get(req.params.reference);
  if(!booking)return res.redirect('/track'); res.render('booking-success',{title:'Request received',booking});
});
app.get('/track',(req,res)=>res.render('track',{title:'Track Your Booking',booking:null,history:[],error:null,values:{}}));
app.post('/track',formLimiter,(req,res)=>{
  const reference=h.clean(req.body.reference,40).toUpperCase(),mobile=h.phone(req.body.phone);
  if(!reference||!mobile)return res.status(422).render('track',{title:'Track Your Booking',booking:null,history:[],error:'Enter a valid booking reference and 10-digit mobile number.',values:{reference,phone:req.body.phone}});
  const booking=db.prepare(`SELECT b.*,s.name service_name,s.image service_image,t.name technician_name,q.total quotation_total,q.status quotation_status FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE b.reference=? AND b.phone=?`).get(reference,mobile);
  if(!booking)return res.status(404).render('track',{title:'Track Your Booking',booking:null,history:[],error:'No matching booking was found. Check both details and try again.',values:{reference,phone:mobile}});
  const history=db.prepare('SELECT * FROM booking_status_history WHERE booking_id=? ORDER BY created_at').all(booking.id); res.render('track',{title:`Track ${reference}`,booking,history,error:null,values:{reference,phone:mobile}});
});
app.get('/contact',(req,res)=>res.render('contact',{title:'Contact FixMitra',errors:{},values:{}}));
app.post('/contact',formLimiter,(req,res)=>{
  const v={name:h.clean(req.body.name,120),email:h.email(req.body.email),phone:h.clean(req.body.phone,20),subject:h.clean(req.body.subject,150),message:h.clean(req.body.message,3000)},errors={};
  if(v.name.length<2)errors.name='Enter your name.'; if(!v.email)errors.email='Enter a valid email.'; if(v.phone&&!h.phone(v.phone))errors.phone='Use a valid 10-digit Indian mobile number.'; if(v.subject.length<3)errors.subject='Enter a subject.'; if(v.message.length<15)errors.message='Please add at least 15 characters.';
  if(Object.keys(errors).length)return res.status(422).render('contact',{title:'Contact FixMitra',errors,values:req.body});
  db.prepare('INSERT INTO contact_messages(name,email,phone,subject,message) VALUES (?,?,?,?,?)').run(v.name,v.email,v.phone,v.subject,v.message); notify({role:'admin',title:'New contact message',message:`${v.name}: ${v.subject}`}); h.flash(req,'success','Your message has been saved. Our support team can now review it.'); res.redirect('/contact');
});

app.get('/register',(req,res)=>res.render('auth/register',{title:'Create your account',errors:{},values:{}}));
app.post('/register',authLimiter,(req,res)=>{
  const v={name:h.clean(req.body.name,120),email:h.email(req.body.email),phone:h.phone(req.body.phone),password:String(req.body.password||''),confirm:String(req.body.confirm||'')},errors={};
  if(v.name.length<2)errors.name='Enter your full name.'; if(!v.email)errors.email='Enter a valid email.'; if(!v.phone)errors.phone='Enter a valid 10-digit Indian mobile number.'; if(v.password.length<10)errors.password='Use at least 10 characters.'; if(v.password!==v.confirm)errors.confirm='Passwords do not match.'; if(v.email&&db.prepare('SELECT id FROM users WHERE email=?').get(v.email))errors.email='An account already exists for this email.';
  if(Object.keys(errors).length)return res.status(422).render('auth/register',{title:'Create your account',errors,values:req.body});
  const info=db.prepare("INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?,'customer')").run(v.name,v.email,v.phone,hashPassword(v.password)); db.prepare('INSERT INTO customer_profiles(user_id) VALUES (?)').run(info.lastInsertRowid);
  req.session.regenerate(err=>{if(err)return res.status(500).render('error',{title:'Could not sign in',status:500,message:'Please try again.'});req.session.user={id:Number(info.lastInsertRowid),name:v.name,email:v.email,role:'customer'};h.flash(req,'success','Your customer account is ready.');res.redirect('/dashboard');});
});
app.get('/login',(req,res)=>res.render('auth/login',{title:'Customer login',admin:false,next:safeNext(req.query.next,'/dashboard'),error:null}));
app.post('/login',authLimiter,(req,res)=>loginHandler(req,res,'customer'));
app.get('/admin/login',(req,res)=>res.render('auth/login',{title:'Administrator login',admin:true,next:'/admin',error:null}));
app.post('/admin/login',authLimiter,(req,res)=>loginHandler(req,res,'admin'));
function loginHandler(req,res,role){const em=h.email(req.body.email);const user=em?db.prepare('SELECT * FROM users WHERE email=? AND role=? AND active=1').get(em,role):null; if(!user||!verifyPassword(String(req.body.password||''),user.password_hash))return res.status(401).render('auth/login',{title:role==='admin'?'Administrator login':'Customer login',admin:role==='admin',next:safeNext(req.body.next,role==='admin'?'/admin':'/dashboard'),error:'The email or password is incorrect.'}); req.session.regenerate(err=>{if(err)return res.status(500).render('error',{title:'Login failed',status:500,message:'Please try again.'});req.session.user={id:user.id,name:user.name,email:user.email,role:user.role};res.redirect(safeNext(req.body.next,role==='admin'?'/admin':'/dashboard'));});}
app.post('/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('fixmitra.sid');res.redirect('/');}));

app.get('/dashboard',customerOnly,(req,res)=>{
  const stats=db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status IN ('New','Contacted','Quoted','Confirmed','Technician Assigned','In Progress') THEN 1 ELSE 0 END) active,SUM(CASE WHEN status='Completed' THEN 1 ELSE 0 END) completed FROM bookings WHERE user_id=?`).get(req.session.user.id);
  const bookings=db.prepare(`SELECT b.*,s.name service_name,q.total quotation_total FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE b.user_id=? ORDER BY b.created_at DESC LIMIT 8`).all(req.session.user.id);
  const notifications=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 6').all(req.session.user.id);
  res.render('customer/dashboard',{title:'Customer Dashboard',stats,bookings,notifications});
});
app.get('/dashboard/bookings',(req,res)=>{res.redirect('/dashboard');});
app.get('/dashboard/bookings/:id',customerOnly,(req,res)=>{
  const booking=db.prepare(`SELECT b.*,s.name service_name,s.image,t.name technician_name,q.total quotation_total,q.status quotation_status FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE b.id=? AND b.user_id=?`).get(Number(req.params.id),req.session.user.id);
  if(!booking)return res.status(404).render('error',{title:'Booking not found',status:404,message:'This booking does not exist or does not belong to your account.'}); const history=db.prepare('SELECT * FROM booking_status_history WHERE booking_id=? ORDER BY created_at').all(booking.id); const review=db.prepare('SELECT * FROM reviews WHERE booking_id=? AND user_id=?').get(booking.id,req.session.user.id); res.render('customer/booking',{title:booking.reference,booking,history,review});
});
app.post('/dashboard/bookings/:id/review',customerOnly,(req,res)=>{
  const booking=db.prepare("SELECT id FROM bookings WHERE id=? AND user_id=? AND status='Completed'").get(Number(req.params.id),req.session.user.id); if(!booking){h.flash(req,'error','Feedback is available only for your completed bookings.');return res.redirect('/dashboard');}
  const rating=Number(req.body.rating),comment=h.clean(req.body.comment,1000); if(!Number.isInteger(rating)||rating<1||rating>5||comment.length<10){h.flash(req,'error','Choose a rating and add at least 10 characters.');return res.redirect(`/dashboard/bookings/${booking.id}`)}
  db.prepare(`INSERT INTO reviews(booking_id,user_id,rating,comment) VALUES (?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,published=0`).run(booking.id,req.session.user.id,rating,comment);h.flash(req,'success','Thank you. Your feedback is awaiting moderation.');res.redirect(`/dashboard/bookings/${booking.id}`);
});
app.get('/dashboard/profile',customerOnly,(req,res)=>{const profile=db.prepare('SELECT u.*,p.* FROM users u LEFT JOIN customer_profiles p ON p.user_id=u.id WHERE u.id=?').get(req.session.user.id);res.render('customer/profile',{title:'Profile Settings',profile,errors:{}})});
app.post('/dashboard/profile',customerOnly,(req,res)=>{const v={name:h.clean(req.body.name,120),phone:h.phone(req.body.phone),building:h.clean(req.body.building,150),street:h.clean(req.body.street,200),city:h.clean(req.body.city,100),state:h.clean(req.body.state,100),pincode:h.clean(req.body.pincode,10)},errors={};if(v.name.length<2)errors.name='Enter your full name.';if(!v.phone)errors.phone='Enter a valid mobile number.';if(v.pincode&&!h.pincode(v.pincode))errors.pincode='Enter a 6-digit PIN code.';if(Object.keys(errors).length){const profile={...v,email:req.session.user.email};return res.status(422).render('customer/profile',{title:'Profile Settings',profile,errors});}db.transaction(()=>{db.prepare('UPDATE users SET name=?,phone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(v.name,v.phone,req.session.user.id);db.prepare(`UPDATE customer_profiles SET building=?,street=?,city=?,state=?,pincode=? WHERE user_id=?`).run(v.building,v.street,v.city,v.state,v.pincode,req.session.user.id)})();req.session.user.name=v.name;h.flash(req,'success','Profile updated.');res.redirect('/dashboard/profile')});
app.post('/dashboard/password',customerOnly,authLimiter,(req,res)=>changePassword(req,res,'/dashboard/profile'));
function changePassword(req,res,redirect){const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id),current=String(req.body.current_password||''),next=String(req.body.new_password||'');if(!verifyPassword(current,user.password_hash)||next.length<10){h.flash(req,'error','Current password was incorrect or the new password has fewer than 10 characters.');return res.redirect(redirect)}db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(next),user.id);h.flash(req,'success','Password changed successfully.');res.redirect(redirect)}

app.use('/admin',(req,res,next)=>{if(req.path==='/admin/login')return next();adminOnly(req,res,next)});
app.get('/admin',(req,res)=>{
  const stats=db.prepare(`SELECT COUNT(*) total,SUM(status='New') new_count,SUM(status='Quoted') pending_quotes,SUM(status='Confirmed') confirmed,SUM(status='Completed') completed FROM bookings`).get();
  stats.customers=db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n;stats.technicians=db.prepare('SELECT COUNT(*) n FROM technicians WHERE active=1').get().n;stats.services=db.prepare('SELECT COUNT(*) n FROM services WHERE active=1').get().n;
  const recent=db.prepare(`SELECT b.*,s.name service_name,t.name technician_name,q.total FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id ORDER BY b.created_at DESC LIMIT 8`).all();
  const statusData=db.prepare('SELECT status,COUNT(*) count FROM bookings GROUP BY status ORDER BY count DESC').all();const serviceData=db.prepare(`SELECT c.name,COUNT(b.id) count FROM service_categories c LEFT JOIN services s ON s.category_id=c.id LEFT JOIN bookings b ON b.service_id=s.id GROUP BY c.id ORDER BY count DESC`).all();
  const monthly=db.prepare(`SELECT strftime('%Y-%m',created_at) month,COUNT(*) count FROM bookings GROUP BY month ORDER BY month DESC LIMIT 6`).all().reverse();
  res.render('admin/overview',{title:'Overview',adminPage:'overview',stats,recent,statusData,serviceData,monthly});
});
app.get('/admin/bookings',(req,res)=>{
  const q=h.clean(req.query.q,100),status=h.clean(req.query.status,40),service=Number(req.query.service)||0,date=h.clean(req.query.date,10);const where=['1=1'],params=[];
  if(q){where.push('(b.reference LIKE ? OR b.customer_name LIKE ?)');params.push(`%${q}%`,`%${q}%`)}if(status){where.push('b.status=?');params.push(status)}if(service){where.push('b.service_id=?');params.push(service)}if(date){where.push('b.appointment_date=?');params.push(date)}
  const total=db.prepare(`SELECT COUNT(*) n FROM bookings b WHERE ${where.join(' AND ')}`).get(...params).n,p=h.paginate(req.query.page,total,10);
  const bookings=db.prepare(`SELECT b.*,s.name service_name,t.name technician_name,q.total FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE ${where.join(' AND ')} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`).all(...params,p.perPage,p.offset);
  const services=db.prepare('SELECT id,name FROM services ORDER BY name').all();res.render('admin/bookings',{title:'Bookings',adminPage:'bookings',bookings,services,p,filters:{q,status,service,date},statuses:h.STATUSES});
});
app.get('/admin/bookings/export.csv',(req,res)=>{const rows=db.prepare(`SELECT b.reference,b.customer_name,b.phone,s.name service,b.appointment_date,b.appointment_time,b.status,t.name technician,q.total quotation_value FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id ORDER BY b.created_at DESC`).all();res.type('text/csv').attachment('fixmitra-bookings.csv').send(csv(rows));});
app.get('/admin/bookings/:id',(req,res)=>{const booking=db.prepare(`SELECT b.*,s.name service_name,s.starting_price,t.name technician_name,q.labour,q.materials,q.additional,q.discount,q.total,q.status quotation_status,q.notes quotation_notes FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN technicians t ON t.id=b.technician_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE b.id=?`).get(Number(req.params.id));if(!booking)return res.status(404).render('error',{title:'Booking not found',status:404,message:'The booking does not exist.'});const history=db.prepare(`SELECT h.*,u.name changed_by_name FROM booking_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.booking_id=? ORDER BY h.created_at DESC`).all(booking.id);const technicians=db.prepare('SELECT * FROM technicians WHERE active=1 ORDER BY name').all();res.render('admin/booking-detail',{title:booking.reference,adminPage:'bookings',booking,history,technicians,statuses:h.STATUSES})});
app.post('/admin/bookings/:id/update',(req,res)=>{
  const id=Number(req.params.id),booking=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);if(!booking)return res.sendStatus(404);const status=h.STATUSES.includes(req.body.status)?req.body.status:booking.status,technicianId=Number(req.body.technician_id)||null,notes=h.clean(req.body.internal_notes,3000);
  if(technicianId&&!db.prepare('SELECT id FROM technicians WHERE id=? AND active=1').get(technicianId)){h.flash(req,'error','Only active technicians can be assigned.');return res.redirect(`/admin/bookings/${id}`)}
  const appointmentDate=h.clean(req.body.appointment_date,10)||booking.appointment_date,appointmentTime=h.clean(req.body.appointment_time,5)||booking.appointment_time,problem=h.clean(req.body.problem,2000)||booking.problem;
  db.transaction(()=>{db.prepare('UPDATE bookings SET status=?,technician_id=?,internal_notes=?,appointment_date=?,appointment_time=?,problem=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,technicianId,notes,appointmentDate,appointmentTime,problem,id);if(status!==booking.status)db.prepare('INSERT INTO booking_status_history(booking_id,status,note,changed_by) VALUES (?,?,?,?)').run(id,status,h.clean(req.body.status_note,500)||'Status updated by administrator.',req.session.user.id);notify({userId:booking.user_id,title:`Booking ${status}`,message:`${booking.reference} is now ${status}.`,bookingId:id})})();h.flash(req,'success','Booking updated and status history saved.');res.redirect(`/admin/bookings/${id}`);
});
app.post('/admin/bookings/:id/cancel',(req,res)=>{const id=Number(req.params.id),b=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);if(!b)return res.sendStatus(404);db.transaction(()=>{db.prepare("UPDATE bookings SET status='Cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);db.prepare("INSERT INTO booking_status_history(booking_id,status,note,changed_by) VALUES (?,'Cancelled',?,?)").run(id,h.clean(req.body.reason,500)||'Cancelled by administrator.',req.session.user.id);notify({userId:b.user_id,title:'Booking cancelled',message:`${b.reference} was cancelled.`,bookingId:id})})();h.flash(req,'success','Booking cancelled.');res.redirect(`/admin/bookings/${id}`)});

app.get('/admin/technicians',(req,res)=>{const q=h.clean(req.query.q,100);const techs=q?db.prepare('SELECT *, (SELECT COUNT(*) FROM bookings b WHERE b.technician_id=technicians.id AND b.status<>\'Cancelled\') workload, (SELECT COUNT(*) FROM bookings b WHERE b.technician_id=technicians.id AND b.status=\'Completed\') completed_jobs FROM technicians WHERE name LIKE ? OR specialization LIKE ? ORDER BY active DESC,name').all(`%${q}%`,`%${q}%`):db.prepare('SELECT *, (SELECT COUNT(*) FROM bookings b WHERE b.technician_id=technicians.id AND b.status<>\'Cancelled\') workload, (SELECT COUNT(*) FROM bookings b WHERE b.technician_id=technicians.id AND b.status=\'Completed\') completed_jobs FROM technicians ORDER BY active DESC,name').all();res.render('admin/technicians',{title:'Technicians',adminPage:'technicians',techs,q})});
app.post('/admin/technicians/save',(req,res)=>{const id=Number(req.body.id)||null,v={name:h.clean(req.body.name,120),phone:h.phone(req.body.phone),email:h.email(req.body.email),specialization:h.clean(req.body.specialization,120),experience:Math.max(0,Number(req.body.experience)||0),service_areas:h.clean(req.body.service_areas,200),availability:h.clean(req.body.availability,40)};if(!v.name||!v.phone||!v.email||!v.specialization){h.flash(req,'error','Name, valid phone, email and specialization are required.');return res.redirect('/admin/technicians')}try{if(id)db.prepare(`UPDATE technicians SET name=?,phone=?,email=?,specialization=?,experience=?,service_areas=?,availability=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...Object.values(v),id);else db.prepare(`INSERT INTO technicians(name,phone,email,specialization,experience,service_areas,availability,is_demo) VALUES (?,?,?,?,?,?,?,0)`).run(...Object.values(v));h.flash(req,'success',id?'Technician updated.':'Technician added.')}catch(e){h.flash(req,'error','That technician email is already in use.')}res.redirect('/admin/technicians')});
app.post('/admin/technicians/:id/toggle',(req,res)=>{db.prepare('UPDATE technicians SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(req.params.id));h.flash(req,'success','Technician account status changed.');res.redirect('/admin/technicians')});

app.get('/admin/services',(req,res)=>{const services=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id ORDER BY c.sort_order,s.name`).all();const categories=db.prepare('SELECT * FROM service_categories ORDER BY sort_order').all();res.render('admin/services',{title:'Services',adminPage:'services',services,categories})});
app.post('/admin/services/save',upload.single('image'),(req,res)=>{const id=Number(req.body.id)||null,name=h.clean(req.body.name,120),slug=h.slugify(req.body.slug||name),category=Number(req.body.category_id),description=h.clean(req.body.description,2000),inclusions=h.clean(req.body.inclusions,1500),instructions=h.clean(req.body.instructions,1500),duration=h.clean(req.body.duration,80),price=Math.max(0,Number(req.body.starting_price)||0);const existing=id?db.prepare('SELECT * FROM services WHERE id=?').get(id):null;const image=req.file?`/uploads/${req.file.filename}`:(existing?.image||'/images/service-maintenance.webp');if(!name||!slug||!category||!description){h.flash(req,'error','Name, category and description are required.');return res.redirect('/admin/services')}try{if(id)db.prepare(`UPDATE services SET category_id=?,name=?,slug=?,description=?,inclusions=?,instructions=?,duration=?,starting_price=?,image=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(category,name,slug,description,inclusions,instructions,duration,price,image,id);else db.prepare(`INSERT INTO services(category_id,name,slug,description,inclusions,instructions,duration,starting_price,image,is_demo) VALUES (?,?,?,?,?,?,?,?,?,0)`).run(category,name,slug,description,inclusions,instructions,duration,price,image);h.flash(req,'success',id?'Service updated.':'Service created.')}catch(e){h.flash(req,'error','The service slug must be unique.')}res.redirect('/admin/services')});
app.post('/admin/services/:id/toggle',(req,res)=>{db.prepare('UPDATE services SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(req.params.id));h.flash(req,'success','Service availability changed on the public website.');res.redirect('/admin/services')});
app.post('/admin/categories/save',(req,res)=>{const name=h.clean(req.body.name,100),slug=h.slugify(req.body.slug||name),description=h.clean(req.body.description,500);if(!name||!slug)return res.redirect('/admin/services');try{db.prepare('INSERT INTO service_categories(name,slug,description,image,sort_order) VALUES (?,?,?,?,99)').run(name,slug,description,'/images/service-maintenance.webp');h.flash(req,'success','Category created.')}catch(e){h.flash(req,'error','Category name and slug must be unique.')}res.redirect('/admin/services')});
app.post('/admin/categories/:id/save',(req,res)=>{const name=h.clean(req.body.name,100),description=h.clean(req.body.description,500),sort=Math.max(0,Number(req.body.sort_order)||0);if(name)db.prepare('UPDATE service_categories SET name=?,description=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name,description,sort,Number(req.params.id));h.flash(req,'success','Category updated.');res.redirect('/admin/services')});
app.post('/admin/categories/:id/toggle',(req,res)=>{db.prepare('UPDATE service_categories SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(req.params.id));h.flash(req,'success','Category visibility changed.');res.redirect('/admin/services')});

app.get('/admin/pricing',(req,res)=>{const services=db.prepare(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id ORDER BY c.sort_order,s.name`).all();res.render('admin/pricing',{title:'Pricing',adminPage:'pricing',services})});
app.post('/admin/pricing/:id',(req,res)=>{const price=Math.max(0,Number(req.body.starting_price)||0),inspection=Math.max(0,Number(req.body.inspection_fee)||0),discount=Math.min(100,Math.max(0,Number(req.body.discount_percent)||0));db.prepare('UPDATE services SET starting_price=?,inspection_fee=?,discount_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(price,inspection,discount,Number(req.params.id));h.flash(req,'success','Pricing updated and published.');res.redirect('/admin/pricing')});
app.get('/admin/quotations',(req,res)=>{const rows=db.prepare(`SELECT b.id booking_id,b.reference,b.customer_name,s.name service_name,b.status booking_status,q.labour,q.materials,q.additional,q.discount,q.total,q.status quotation_status,q.updated_at FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN quotations q ON q.booking_id=b.id ORDER BY COALESCE(q.updated_at,b.created_at) DESC`).all();res.render('admin/quotations',{title:'Quotations',adminPage:'quotations',rows})});
app.post('/admin/bookings/:id/quotation',(req,res)=>{const id=Number(req.params.id),b=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);if(!b)return res.sendStatus(404);const labour=Math.max(0,Number(req.body.labour)||0),materials=Math.max(0,Number(req.body.materials)||0),additional=Math.max(0,Number(req.body.additional)||0),discount=Math.max(0,Number(req.body.discount)||0),total=Math.max(0,labour+materials+additional-discount),status=['Draft','Sent','Accepted','Declined'].includes(req.body.quotation_status)?req.body.quotation_status:'Draft',notes=h.clean(req.body.quotation_notes,1500);db.transaction(()=>{db.prepare(`INSERT INTO quotations(booking_id,labour,materials,additional,discount,total,status,notes,created_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO UPDATE SET labour=excluded.labour,materials=excluded.materials,additional=excluded.additional,discount=excluded.discount,total=excluded.total,status=excluded.status,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`).run(id,labour,materials,additional,discount,total,status,notes,req.session.user.id);if(status==='Sent'&&b.status!=='Quoted'){db.prepare("UPDATE bookings SET status='Quoted',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);db.prepare("INSERT INTO booking_status_history(booking_id,status,note,changed_by) VALUES (?,'Quoted','Illustrative quotation made available.',?)").run(id,req.session.user.id)}notify({userId:b.user_id,title:'Quotation updated',message:`An estimated quotation is available for ${b.reference}. This is not a payment receipt.`,bookingId:id})})();h.flash(req,'success',`Quotation saved. Estimated total: ${h.formatINR(total)}.`);res.redirect(`/admin/bookings/${id}`)});

app.get('/admin/customers',(req,res)=>{const q=h.clean(req.query.q,100),active=req.query.active;let where="u.role='customer'",params=[];if(q){where+=' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';params=[`%${q}%`,`%${q}%`,`%${q}%`]}if(active==='1'||active==='0'){where+=' AND u.active=?';params.push(Number(active))}const customers=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.active,u.created_at,p.city,p.state,p.is_demo,COUNT(b.id) bookings,SUM(CASE WHEN b.status='Completed' THEN 1 ELSE 0 END) completed FROM users u LEFT JOIN customer_profiles p ON p.user_id=u.id LEFT JOIN bookings b ON b.user_id=u.id WHERE ${where} GROUP BY u.id ORDER BY u.created_at DESC`).all(...params);res.render('admin/customers',{title:'Customers',adminPage:'customers',customers,q,active})});
app.get('/admin/customers/:id',(req,res)=>{const customer=db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.active,u.created_at,p.* FROM users u LEFT JOIN customer_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='customer'`).get(Number(req.params.id));if(!customer)return res.status(404).render('error',{title:'Customer not found',status:404,message:'The customer record does not exist.'});const bookings=db.prepare(`SELECT b.*,s.name service_name,q.total FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN quotations q ON q.booking_id=b.id WHERE b.user_id=? ORDER BY b.created_at DESC`).all(customer.id);res.render('admin/customer-detail',{title:customer.name,adminPage:'customers',customer,bookings})});
app.post('/admin/customers/:id/toggle',(req,res)=>{db.prepare("UPDATE users SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND role='customer'").run(Number(req.params.id));h.flash(req,'success','Customer account status changed.');res.redirect('/admin/customers')});
app.get('/admin/reviews',(req,res)=>{const reviews=db.prepare(`SELECT r.*,u.name,b.reference,s.name service_name FROM reviews r JOIN users u ON u.id=r.user_id JOIN bookings b ON b.id=r.booking_id JOIN services s ON s.id=b.service_id ORDER BY r.created_at DESC`).all();res.render('admin/reviews',{title:'Reviews & Feedback',adminPage:'reviews',reviews})});
app.post('/admin/reviews/:id/toggle',(req,res)=>{db.prepare('UPDATE reviews SET published=CASE published WHEN 1 THEN 0 ELSE 1 END WHERE id=?').run(Number(req.params.id));h.flash(req,'success','Review visibility changed.');res.redirect('/admin/reviews')});
app.post('/admin/reviews/:id/delete',(req,res)=>{db.prepare('DELETE FROM reviews WHERE id=?').run(Number(req.params.id));h.flash(req,'success','Review removed.');res.redirect('/admin/reviews')});
app.get('/admin/reports',(req,res)=>{const from=h.clean(req.query.from,10),to=h.clean(req.query.to,10),where=[],params=[];if(from){where.push('date(b.created_at)>=?');params.push(from)}if(to){where.push('date(b.created_at)<=?');params.push(to)}const w=where.length?`WHERE ${where.join(' AND ')}`:'';const summary=db.prepare(`SELECT COUNT(*) total,SUM(b.status='Completed') completed,SUM(b.status='Cancelled') cancelled,COALESCE(SUM(q.total),0) quotation_value FROM bookings b LEFT JOIN quotations q ON q.booking_id=b.id ${w}`).get(...params);const categories=db.prepare(`SELECT c.name,COUNT(b.id) count FROM service_categories c LEFT JOIN services s ON s.category_id=c.id LEFT JOIN bookings b ON b.service_id=s.id ${w?`${w} AND b.id IS NOT NULL`:''} GROUP BY c.id ORDER BY count DESC`).all(...params);const techs=db.prepare(`SELECT t.name,COUNT(b.id) workload,SUM(b.status='Completed') completed FROM technicians t LEFT JOIN bookings b ON b.technician_id=t.id ${w} GROUP BY t.id ORDER BY workload DESC`).all(...params);res.render('admin/reports',{title:'Reports & Analytics',adminPage:'reports',summary,categories,techs,filters:{from,to}})});
app.get('/admin/reports/export.csv',(req,res)=>{const rows=db.prepare(`SELECT strftime('%Y-%m',b.created_at) month,COUNT(*) bookings,SUM(b.status='Completed') completed,SUM(b.status='Cancelled') cancelled,COALESCE(SUM(q.total),0) quotation_value FROM bookings b LEFT JOIN quotations q ON q.booking_id=b.id GROUP BY month ORDER BY month`).all();res.type('text/csv').attachment('fixmitra-report.csv').send(csv(rows))});
app.get('/admin/settings',(req,res)=>{const settings=db.prepare('SELECT * FROM admin_settings WHERE id=1').get();const messages=db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 10').all();res.render('admin/settings',{title:'Settings',adminPage:'settings',settings,messages})});
app.post('/admin/settings',(req,res)=>{const v={company:h.clean(req.body.company_name,120),email:h.email(req.body.business_email),phone:h.clean(req.body.business_phone,30),area:h.clean(req.body.service_area,200),hours:h.clean(req.body.operating_hours,200),currency:h.clean(req.body.currency,10),notice:h.clean(req.body.booking_notice,500),emailN:req.body.email_notifications?1:0,waN:req.body.whatsapp_notifications?1:0};if(!v.company||!v.email||!v.area){h.flash(req,'error','Company, valid email and service area are required.');return res.redirect('/admin/settings')}db.prepare(`UPDATE admin_settings SET company_name=?,business_email=?,business_phone=?,service_area=?,operating_hours=?,currency=?,booking_notice=?,email_notifications=?,whatsapp_notifications=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(...Object.values(v));h.flash(req,'success','Business settings updated. External message delivery remains disabled until credentials are configured.');res.redirect('/admin/settings')});
app.post('/admin/settings/password',authLimiter,(req,res)=>changePassword(req,res,'/admin/settings'));
app.post('/admin/settings/reset-demo',(req,res)=>{if(req.body.confirm!=='RESET DEMO'){h.flash(req,'error','Type RESET DEMO exactly to continue.');return res.redirect('/admin/settings')}seedDemo({force:true});h.flash(req,'success','Demonstration records were reset. Real customer records were preserved.');res.redirect('/admin')});

function csv(rows){if(!rows.length)return '';const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;return Object.keys(rows[0]).map(esc).join(',')+'\n'+rows.map(r=>Object.values(r).map(esc).join(',')).join('\n');}
app.use((req,res)=>res.status(404).render('error',{title:'Page not found',status:404,message:'The page you requested could not be found.'}));
app.use((err,req,res,next)=>{console.error(err);if(err instanceof multer.MulterError){h.flash(req,'error','Image upload failed. Use a JPG, PNG or WebP file up to 2 MB.');return res.redirect('/admin/services')}res.status(500).render('error',{title:'Something went wrong',status:500,message:process.env.NODE_ENV==='production'?'The request could not be completed. Please try again.':err.message});});
module.exports=app;
