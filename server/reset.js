// Regenera los datos de demostración (CMMS y JDE simulado)
const { wipe, seed } = require('./seed');
wipe();
seed();
console.log('Datos regenerados. Inicie con: npm start');
