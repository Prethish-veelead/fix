const {seedDemo}=require('../src/db');
if(process.env.CONFIRM_RESET!=='RESET DEMO'){console.error('Set CONFIRM_RESET="RESET DEMO" to confirm. Real customer records will be preserved.');process.exit(1)}seedDemo({force:true});console.log('Demonstration data reset successfully.');
