const crypto = require('crypto');
function hashPassword(password){
  const salt=crypto.randomBytes(16);
  const derived=crypto.scryptSync(String(password),salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
function verifyPassword(password,stored){
  try{const [kind,saltHex,hashHex]=String(stored).split('$');if(kind!=='scrypt'||!saltHex||!hashHex)return false;const expected=Buffer.from(hashHex,'hex');const actual=crypto.scryptSync(String(password),Buffer.from(saltHex,'hex'),expected.length,{N:16384,r:8,p:1,maxmem:64*1024*1024});return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual)}catch{return false}
}
module.exports={hashPassword,verifyPassword};
