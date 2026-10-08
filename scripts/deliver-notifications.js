require('dotenv').config();
if(process.env.PUSH_NOTIFICATIONS_ENABLED!=='true') {
  console.log('Push delivery disabled. Set PUSH_NOTIFICATIONS_ENABLED=true on the worker.');
  process.exitCode=0;
} else {
  require('../dist/passengers/push.service').deliverPublishedAlerts()
    .then(()=>process.exit(0)).catch(error=>{console.error(error.message);process.exit(1);});
}
