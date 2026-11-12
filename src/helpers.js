const crypto = require('crypto');

const STATUSES = ['New','Contacted','Quoted','Confirmed','Technician Assigned','In Progress','Completed','Cancelled'];
const ACTIVE_STATUSES = ['New','Contacted','Quoted','Confirmed','Technician Assigned','In Progress'];

function clean(value, max=5000) { return String(value || '').trim().replace(/\0/g,'').slice(0,max); }
function email(value) { const v=clean(value,254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null; }
function phone(value) { const v=clean(value,20).replace(/\D/g,''); return /^[6-9]\d{9}$/.test(v) ? v : null; }
function pincode(value) { const v=clean(value,10); return /^\d{6}$/.test(v) ? v : null; }
function formatINR(value) { return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)); }
function formatDate(value) {
  if(!value) return '—';
  const d=new Date(String(value).length===10?`${value}T00:00:00`:value);
  return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric'}).format(d);
}
function formatDateTime(value) {
  if(!value) return '—'; const d=new Date(value.replace(' ','T')+'Z');
  return Number.isNaN(d.getTime())?'—':new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}
function bookingRef() { return `FM-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function slugify(v) { return clean(v,100).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function isFutureDate(v) { const d=new Date(`${v}T23:59:59`); return /^\d{4}-\d{2}-\d{2}$/.test(v) && d >= new Date(); }
function flash(req,type,message){req.session.flash={type,message};}
function paginate(page,total,perPage=10){ page=Math.max(1,Number(page)||1); const pages=Math.max(1,Math.ceil(total/perPage)); page=Math.min(page,pages); return {page,pages,perPage,offset:(page-1)*perPage,total}; }
function statusClass(status){return `status-${String(status).toLowerCase().replace(/\s+/g,'-')}`;}
module.exports={STATUSES,ACTIVE_STATUSES,clean,email,phone,pincode,formatINR,formatDate,formatDateTime,bookingRef,slugify,isFutureDate,flash,paginate,statusClass};
