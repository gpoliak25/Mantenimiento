// Catálogo de dominio: sistemas, tipos de mantenimiento, niveles del plan
// preventivo, repuestos, variables IoT y mapeos de códigos JDE.

const SYSTEMS = [
  'Frenos', 'Dirección y suspensión', 'Motor y refrigeración', 'Ejes y transmisión', 'Puertas',
  'Neumáticos', 'Sistema eléctrico', 'Climatización', 'Rampa o elevador', 'Batería de tracción',
];
// Sistemas cuyas fallas impiden iniciar o completar un viaje (fallas mayores)
const MAJOR_SYSTEMS = SYSTEMS.slice(0, 5);

// Los 7 tipos de mantenimiento y su código de tipo de OT en JDE (UDC 00/TY)
const WO_TYPES = {
  PREVENTIVO: { label: 'Preventivo', jde: '1', planned: true },
  CORRECTIVO: { label: 'Correctivo', jde: '2', planned: false },
  PREDICTIVO: { label: 'Predictivo', jde: '3', planned: true },
  PROACTIVO: { label: 'Proactivo', jde: '4', planned: true },
  CONDICION: { label: 'Basado en condición', jde: '5', planned: true },
  DETECTIVO: { label: 'Detectivo', jde: '6', planned: true },
  AUTONOMO: { label: 'Autónomo', jde: '7', planned: false },
};

// Flujo del taller (diapositiva 13) y estado de OT en JDE (UDC 00/SS)
const STAGES = [
  { key: 'ORDEN', label: 'Orden de trabajo', jde: '10' },
  { key: 'DIAGNOSTICO', label: 'Diagnóstico', jde: '20' },
  { key: 'REPUESTOS', label: 'Repuestos', jde: '30' },
  { key: 'REPARACION', label: 'Reparación', jde: '40' },
  { key: 'CONTROL', label: 'Control y cierre', jde: '80' },
  { key: 'CERRADA', label: 'Cerrada', jde: '99' },
];

// Estado de unidad <-> Equipment Status JDE (UDC 12/ES)
const UNIT_STATUS = {
  DISPONIBLE: { label: 'Disponible', jde: 'AV' },
  EN_TALLER: { label: 'En taller', jde: 'IR' },
  FUERA_SERVICIO: { label: 'Fuera de servicio', jde: 'DN' },
};
const JDE_TO_UNIT_STATUS = { AV: 'DISPONIBLE', IR: 'EN_TALLER', DN: 'FUERA_SERVICIO' };

// Plan por niveles (diapositiva 7). Intervalos sobre la base de TRB/TCRP (2010):
// el 92% de las agencias inspecciona cada 3.200–9.700 km; tolerancia ±10%.
const PM_PLANS = [
  {
    level: 'A', name: 'Nivel A — Inspección y servicio básico', interval_km: 10000, interval_days: 60, std_hours: 3, jde_service_type: 'PMA', rank: 1,
    tasks: ['Cambio de aceite y filtro de motor', 'Filtro de combustible', 'Inspección de frenos y medición de pastillas', 'Presión y desgaste de neumáticos', 'Luces y sistema eléctrico', 'Puertas: mecanismo y sensores', 'Purga de tanques de aire'],
    kit: [{ item: 'MT-2001', qty: 1, ice: true }, { item: 'MT-2004', qty: 28, ice: true }, { item: 'MT-2002', qty: 1, ice: true }],
  },
  {
    level: 'B', name: 'Nivel B — Inspección intermedia de chasis y sistemas', interval_km: 30000, interval_days: 180, std_hours: 5, jde_service_type: 'PMB', rank: 2,
    tasks: ['Todo lo del nivel A', 'Filtro de aire', 'Cartucho del secador de aire', 'Dirección: rótulas y juego', 'Suspensión: bolsas de aire y amortiguadores', 'Filtro de habitáculo y A/C', 'Rampa: ciclo completo y finales de carrera'],
    kit: [{ item: 'MT-2001', qty: 1, ice: true }, { item: 'MT-2004', qty: 28, ice: true }, { item: 'MT-2002', qty: 1, ice: true }, { item: 'MT-2003', qty: 1, ice: true }, { item: 'FR-1005', qty: 1 }, { item: 'AC-8002', qty: 1 }],
  },
  {
    level: 'C', name: 'Nivel C — Mantenimiento preventivo mayor', interval_km: 90000, interval_days: 450, std_hours: 8, jde_service_type: 'PMC', rank: 3,
    tasks: ['Todo lo del nivel B', 'Aceite y filtro de caja', 'Refrigerante y termostato', 'Correa poly-V', 'Diferencial y cardanes', 'Alineación y balanceo', 'Prueba de baterías y alternador'],
    kit: [{ item: 'MT-2001', qty: 1, ice: true }, { item: 'MT-2004', qty: 28, ice: true }, { item: 'MT-2002', qty: 1, ice: true }, { item: 'MT-2003', qty: 1, ice: true }, { item: 'FR-1005', qty: 1 }, { item: 'AC-8002', qty: 1 }, { item: 'TR-3002', qty: 1 }, { item: 'TR-3001', qty: 20 }, { item: 'MT-2008', qty: 30, ice: true }, { item: 'MT-2005', qty: 1, ice: true }],
  },
  {
    level: 'MAYOR', name: 'Mayor — Motor, caja y ejes', interval_km: 360000, interval_days: 0, std_hours: 40, jde_service_type: 'PMM', rank: 4,
    tasks: ['Overhaul de motor o reemplazo por rotable', 'Caja de cambios reacondicionada', 'Ejes y diferencial', 'Revisión estructural de carrocería', 'Según manual del fabricante y datos de falla'],
    kit: [{ item: 'TR-3005', qty: 1 }, { item: 'MT-2009', qty: 1, ice: true }],
  },
];

// Repuestos (F4101/F41021). Criticidad A/B/C por impacto en el servicio.
const PARTS = [
  ['FR-1001', 'Pastillas de freno eje delantero (juego)', 'Frenos', 'A', 180, 12, 20, 7, 0, 5001],
  ['FR-1002', 'Pastillas de freno eje trasero (juego)', 'Frenos', 'A', 210, 12, 20, 7, 0, 5001],
  ['FR-1003', 'Disco de freno', 'Frenos', 'A', 240, 6, 8, 10, 0, 5001],
  ['FR-1004', 'Válvula relé de aire', 'Frenos', 'A', 150, 4, 6, 12, 0, 5001],
  ['FR-1005', 'Cartucho secador de aire', 'Frenos', 'B', 85, 10, 15, 7, 0, 5001],
  ['FR-1006', 'Pulmón de freno', 'Frenos', 'A', 120, 4, 6, 10, 0, 5001],
  ['FR-1007', 'Compresor de aire (reacondicionado)', 'Frenos', 'A', 1150, 1, 2, 20, 1, 5004],
  ['MT-2001', 'Filtro de aceite de motor', 'Motor y refrigeración', 'B', 25, 20, 40, 5, 0, 5002],
  ['MT-2002', 'Filtro de combustible', 'Motor y refrigeración', 'B', 32, 20, 40, 5, 0, 5002],
  ['MT-2003', 'Filtro de aire', 'Motor y refrigeración', 'B', 48, 10, 20, 5, 0, 5002],
  ['MT-2004', 'Aceite de motor 15W40 (litro)', 'Motor y refrigeración', 'B', 6, 400, 1000, 5, 0, 5002],
  ['MT-2005', 'Correa poly-V', 'Motor y refrigeración', 'B', 55, 6, 10, 7, 0, 5002],
  ['MT-2006', 'Bomba de agua', 'Motor y refrigeración', 'A', 310, 2, 4, 14, 0, 5002],
  ['MT-2007', 'Termostato', 'Motor y refrigeración', 'A', 60, 4, 8, 7, 0, 5002],
  ['MT-2008', 'Refrigerante (litro)', 'Motor y refrigeración', 'B', 5, 200, 400, 5, 0, 5002],
  ['MT-2009', 'Turbocompresor (rotable)', 'Motor y refrigeración', 'A', 1900, 1, 2, 25, 1, 5004],
  ['MT-2010', 'Radiador', 'Motor y refrigeración', 'A', 780, 1, 2, 20, 0, 5002],
  ['TR-3001', 'Aceite de caja ATF (litro)', 'Ejes y transmisión', 'B', 9, 100, 200, 5, 0, 5002],
  ['TR-3002', 'Filtro de caja automática', 'Ejes y transmisión', 'B', 70, 4, 8, 10, 0, 5003],
  ['TR-3003', 'Kit de embrague', 'Ejes y transmisión', 'A', 850, 1, 2, 20, 0, 5003],
  ['TR-3004', 'Cruceta de cardán', 'Ejes y transmisión', 'B', 95, 4, 6, 10, 0, 5003],
  ['TR-3005', 'Caja de cambios reacondicionada (rotable)', 'Ejes y transmisión', 'A', 6500, 1, 1, 45, 1, 5004],
  ['TR-3006', 'Rodamiento de rueda', 'Ejes y transmisión', 'A', 130, 4, 8, 10, 0, 5003],
  ['SU-4001', 'Amortiguador', 'Dirección y suspensión', 'B', 140, 6, 8, 10, 0, 5003],
  ['SU-4002', 'Bolsa de aire (fuelle) de suspensión', 'Dirección y suspensión', 'A', 210, 4, 8, 10, 0, 5003],
  ['SU-4003', 'Rótula de dirección', 'Dirección y suspensión', 'A', 75, 4, 8, 10, 0, 5003],
  ['SU-4004', 'Buje de barra estabilizadora', 'Dirección y suspensión', 'C', 20, 8, 16, 7, 0, 5003],
  ['PU-5001', 'Cilindro/motor de puerta', 'Puertas', 'A', 380, 2, 4, 15, 0, 5005],
  ['PU-5002', 'Sensor de borde sensible', 'Puertas', 'A', 90, 4, 6, 10, 0, 5005],
  ['PU-5003', 'Electroválvula de puerta', 'Puertas', 'A', 110, 3, 6, 10, 0, 5005],
  ['NE-6001', 'Neumático 295/80R22.5', 'Neumáticos', 'A', 420, 12, 16, 10, 0, 5006],
  ['NE-6002', 'Sensor TPMS de válvula', 'Neumáticos', 'C', 45, 10, 20, 7, 0, 5006],
  ['EL-7001', 'Batería 12 V 180 Ah', 'Sistema eléctrico', 'A', 230, 6, 10, 7, 0, 5005],
  ['EL-7002', 'Alternador 28 V (rotable)', 'Sistema eléctrico', 'A', 620, 2, 2, 15, 1, 5004],
  ['EL-7003', 'Faro LED', 'Sistema eléctrico', 'C', 65, 6, 10, 7, 0, 5005],
  ['EL-7004', 'Motor de arranque (rotable)', 'Sistema eléctrico', 'A', 540, 1, 2, 15, 1, 5004],
  ['AC-8001', 'Compresor de A/C (rotable)', 'Climatización', 'B', 1300, 1, 1, 20, 1, 5004],
  ['AC-8002', 'Filtro de habitáculo', 'Climatización', 'C', 30, 10, 20, 5, 0, 5002],
  ['AC-8003', 'Gas refrigerante R134a (kg)', 'Climatización', 'C', 22, 20, 30, 7, 0, 5002],
  ['RA-9001', 'Actuador de rampa', 'Rampa o elevador', 'A', 720, 1, 2, 20, 0, 5005],
  ['RA-9002', 'Sensor de final de carrera', 'Rampa o elevador', 'B', 40, 4, 8, 7, 0, 5005],
  ['BT-9501', 'Módulo de celdas batería de tracción', 'Batería de tracción', 'A', 4800, 1, 1, 60, 0, 5004],
  ['BT-9502', 'Ventilador refrigeración BMS', 'Batería de tracción', 'B', 260, 2, 2, 20, 0, 5004],
].map(([item_no, description, system, criticality, unit_cost, safety_stock, reorder_qty, lead_days, rotable, supplier]) => ({ item_no, description, system, criticality, unit_cost, safety_stock, reorder_qty, lead_days, rotable, supplier }));

// Repuestos habituales de una reparación correctiva por sistema
const REPAIR_PARTS = {
  'Frenos': [['FR-1001', 1], ['FR-1002', 1], ['FR-1004', 1], ['FR-1006', 1], ['FR-1003', 2]],
  'Dirección y suspensión': [['SU-4001', 2], ['SU-4002', 1], ['SU-4003', 1], ['SU-4004', 2]],
  'Motor y refrigeración': [['MT-2006', 1], ['MT-2007', 1], ['MT-2005', 1], ['MT-2010', 1], ['MT-2008', 20]],
  'Ejes y transmisión': [['TR-3004', 1], ['TR-3006', 1], ['TR-3003', 1], ['TR-3002', 1]],
  'Puertas': [['PU-5001', 1], ['PU-5002', 1], ['PU-5003', 1]],
  'Neumáticos': [['NE-6001', 1], ['NE-6002', 1]],
  'Sistema eléctrico': [['EL-7001', 2], ['EL-7003', 1], ['EL-7002', 1], ['EL-7004', 1]],
  'Climatización': [['AC-8003', 3], ['AC-8001', 1]],
  'Rampa o elevador': [['RA-9002', 1], ['RA-9001', 1]],
  'Batería de tracción': [['BT-9502', 1]],
};

// Variables de telemetría (diapositiva 6). dir: sentido de la degradación.
const METRICS = [
  { key: 'coolant_temp', label: 'Temp. refrigerante', unit: '°C', system: 'Motor y refrigeración', base: 86, noise: 1.2, warn: 98, crit: 105, dir: 'up', ice: true, spn: '110' },
  { key: 'oil_pressure', label: 'Presión de aceite', unit: 'bar', system: 'Motor y refrigeración', base: 3.6, noise: 0.15, warn: 1.8, crit: 1.2, dir: 'down', ice: true, spn: '100' },
  { key: 'trans_oil_temp', label: 'Temp. aceite caja', unit: '°C', system: 'Ejes y transmisión', base: 82, noise: 1.5, warn: 110, crit: 120, dir: 'up', spn: '177' },
  { key: 'axle_vibration', label: 'Vibración ejes', unit: 'g', system: 'Ejes y transmisión', base: 0.35, noise: 0.04, warn: 0.9, crit: 1.2, dir: 'up' },
  { key: 'air_pressure', label: 'Presión circuito aire', unit: 'bar', system: 'Frenos', base: 8.8, noise: 0.12, warn: 7.0, crit: 6.0, dir: 'down', spn: '117' },
  { key: 'brake_pad_mm', label: 'Espesor pastillas', unit: 'mm', system: 'Frenos', base: 12, noise: 0.02, warn: 6, crit: 4, dir: 'down', slow: true },
  { key: 'susp_bag_pressure', label: 'Presión bolsas de aire', unit: 'bar', system: 'Dirección y suspensión', base: 5.2, noise: 0.1, warn: 4.0, crit: 3.2, dir: 'down' },
  { key: 'tire_pressure_min', label: 'Presión mínima neumáticos', unit: 'psi', system: 'Neumáticos', base: 116, noise: 0.6, warn: 100, crit: 90, dir: 'down' },
  { key: 'door_current', label: 'Corriente motor puerta', unit: 'A', system: 'Puertas', base: 4.0, noise: 0.25, warn: 7, crit: 9, dir: 'up' },
  { key: 'battery_v', label: 'Tensión baterías 24 V', unit: 'V', system: 'Sistema eléctrico', base: 27.8, noise: 0.12, warn: 25.0, crit: 24.0, dir: 'down', spn: '168' },
  { key: 'traction_temp', label: 'Temp. batería tracción', unit: '°C', system: 'Batería de tracción', base: 31, noise: 0.6, warn: 45, crit: 55, dir: 'up', ev: true },
  { key: 'traction_soh', label: 'Salud batería tracción', unit: '%', system: 'Batería de tracción', base: 92, noise: 0.05, warn: 80, crit: 75, dir: 'down', ev: true, slow: true },
];

// Escenarios de degradación (deriva por lectura) usados por el simulador IoT
const FAULT_SCENARIOS = {
  coolant_temp: { drift: 0.22, label: 'Recalentamiento progresivo (termostato / bomba de agua)', parts: [['MT-2007', 1], ['MT-2008', 20]] },
  oil_pressure: { drift: -0.03, label: 'Caída de presión de aceite', parts: [['MT-2001', 1], ['MT-2004', 28]] },
  trans_oil_temp: { drift: 0.35, label: 'Sobretemperatura de caja', parts: [['TR-3002', 1], ['TR-3001', 20]] },
  axle_vibration: { drift: 0.012, label: 'Desgaste de rodamiento de rueda', parts: [['TR-3006', 1]] },
  air_pressure: { drift: -0.04, label: 'Fuga en circuito de aire', parts: [['FR-1004', 1]] },
  brake_pad_mm: { drift: -0.08, label: 'Desgaste acelerado de pastillas', parts: [['FR-1001', 1]] },
  susp_bag_pressure: { drift: -0.03, label: 'Fuga en bolsa de aire', parts: [['SU-4002', 1]] },
  tire_pressure_min: { drift: -0.35, label: 'Pinchadura lenta', parts: [['NE-6001', 1]] },
  door_current: { drift: 0.05, label: 'Mecanismo de puerta forzado', parts: [['PU-5001', 1]] },
  battery_v: { drift: -0.04, label: 'Baterías por agotarse', parts: [['EL-7001', 2]] },
  traction_temp: { drift: 0.18, label: 'Falla de refrigeración de batería de tracción', parts: [['BT-9502', 1]] },
  traction_soh: { drift: -0.08, label: 'Degradación acelerada de celdas', parts: [['BT-9501', 1]] },
};

// Inspección diaria del conductor (mantenimiento autónomo) y verificación
// de sistemas de seguridad (mantenimiento detectivo)
const INSPECTION_ITEMS = [
  { key: 'neumaticos', label: 'Neumáticos: presión visual, cortes y desgaste', system: 'Neumáticos', safety: true },
  { key: 'luces', label: 'Luces, giros y balizas', system: 'Sistema eléctrico', safety: false },
  { key: 'fluidos', label: 'Niveles de aceite, refrigerante y líquido de frenos', system: 'Motor y refrigeración', safety: false },
  { key: 'perdidas', label: 'Pérdidas visibles bajo la unidad', system: 'Motor y refrigeración', safety: false },
  { key: 'frenos', label: 'Prueba de frenos y presión de aire en tablero', system: 'Frenos', safety: true },
  { key: 'puertas', label: 'Apertura, cierre y sensores de puertas', system: 'Puertas', safety: true },
  { key: 'direccion', label: 'Juego de dirección y suspensión (nivelación)', system: 'Dirección y suspensión', safety: true },
  { key: 'rampa', label: 'Rampa o elevador para movilidad reducida', system: 'Rampa o elevador', safety: false },
  { key: 'emergencia', label: 'Alarmas, salidas de emergencia y matafuegos (detectivo)', system: 'Sistema eléctrico', safety: true, detective: true },
  { key: 'clima', label: 'Aire acondicionado y ventilación', system: 'Climatización', safety: false },
];

const TECHNICIANS = [
  [3101, 'Ramiro Benítez', 'Motor y transmisión', 26],
  [3102, 'Lucía Fernández', 'Frenos y suspensión', 25],
  [3103, 'Martín Ojeda', 'Electricidad y electrónica', 27],
  [3104, 'Carla Duarte', 'Neumáticos y alineación', 23],
  [3105, 'Diego Paz', 'Carrocería, puertas y rampa', 24],
  [3106, 'Sofía Ibarra', 'Climatización y buses eléctricos', 28],
];
const SUPPLIERS = [
  [5001, 'Frenos del Sur S.A.'], [5002, 'Lubricantes y Filtros Norte S.R.L.'], [5003, 'Transmisiones Pampa S.A.'],
  [5004, 'Rotables Reacondicionados S.A.'], [5005, 'Electro Bus Partes S.A.'], [5006, 'Neumáticos Río S.A.'],
];

// Metas de MDBF de referencia (diapositiva 16)
const MDBF_BENCHMARKS = [
  { name: 'Long Beach Transit', km: 9700 }, { name: 'MARTA (Atlanta)', km: 12100 },
  { name: 'SFMTA – Muni', km: 19300 }, { name: 'OCTA (Orange County)', km: 22500 },
];

const AVG_SPEED_KMH = 18; // velocidad comercial media para convertir km en horas de operación
const BRANCH = 'M30';

module.exports = {
  SYSTEMS, MAJOR_SYSTEMS, WO_TYPES, STAGES, UNIT_STATUS, JDE_TO_UNIT_STATUS, PM_PLANS, PARTS, REPAIR_PARTS,
  METRICS, FAULT_SCENARIOS, INSPECTION_ITEMS, TECHNICIANS, SUPPLIERS, MDBF_BENCHMARKS, AVG_SPEED_KMH, BRANCH,
};
