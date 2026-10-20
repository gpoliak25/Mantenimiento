# MVP: gestión de mantenimiento de una flota de colectivos integrada con JDE E1 9.2

Este MVP lleva a una aplicación lo que propone la presentación *Mantenimiento de flota de transporte público*: pasar de la reparación reactiva a la gestión por datos. Incluye:

- la ficha de cada unidad
- órdenes de trabajo que siguen el flujo del taller
- el plan preventivo por niveles
- la inspección diaria del conductor
- telemetría IoT con detección predictiva
- la gestión de repuestos
- los KPIs

Todo se integra con **JD Edwards EnterpriseOne 9.2** a través de **AIS Server / Orchestrator**.

## Cómo ejecutarlo

Requisitos: **Node.js 22.13 o superior** (se probó con 24.16). No necesita `npm install` porque no tiene dependencias externas: usa el SQLite que trae Node.

```bash
npm start          # o doble clic en start.bat
```

| Servicio | URL |
|---|---|
| Sistema de mantenimiento (CMMS) | http://localhost:3100 |
| JDE E1 9.2 AIS Server simulado (tablas F) | http://localhost:8091 |

- `npm run reset` vuelve a generar los datos de demostración: 24 colectivos y 180 días de historia, con los mismos datos en el CMMS y en JDE.
- Variables de entorno: `PORT`, `JDE_AIS_URL`, `JDE_USER`, `JDE_PASSWORD`, `JDE_ENV`, `JDE_ROLE`.
- `JDE_MOCK=0` arranca la app sin el simulador de JDE.
- `npm run build:demo` (con el MVP en ejecución) genera `entregables/Demo-Mantenimiento-Flota.html`: una demo de un solo archivo que funciona sin servidor. El documento de diseño está en `entregables/MVP-Mantenimiento-Flota.html`.

## Torre de Control Logística (demo)

[entregables/Torre-Control-Logistica.html](entregables/Torre-Control-Logistica.html) es una demo de un solo archivo de la **Torre de Control Logística de EISPLUS**: *"Tu ERP sabe qué hay que entregar. ¿Sabe qué pasó en la calle?"*. Se abre con doble clic o en http://localhost:3100/torre con el servidor en marcha.

Simula en el navegador una jornada de distribución en el AMBA:

- **Flota en tiempo real:** 18 unidades (10 propias y 8 de 3 transportistas) con pedidos de venta de JDE.
- **Cadena de frío:** temperatura de cada equipo, con alerta anticipada de excursiones.
- **Mantenimiento:** la telemetría detecta la falla (motor por ECU J1939, neumáticos por TPMS), alerta a Mantenimiento y Tráfico y genera la OT en JDE (F4801). La OT se sigue hasta su cierre con costo real, junto con las entregas afectadas y la salud de la flota.
- **Machine Learning:** ETA del modelo comparado con el ETA del GPS, riesgo de retraso por entrega y patrones detectados.
- **Alertas inteligentes por rol:** torre, tráfico, calidad, atención al cliente, mantenimiento y costos.
- **Costo real por entrega:** comparado con el estimado de JDE, con las causas del desvío.
- **Integración con JDE:** solo AIS y Orchestrator, sin customizar el ERP. Incluye el piloto acotado.

Controles: la velocidad de simulación y el menú **⚡ Simular evento**. Con `?hora=1000` se arranca la jornada más avanzada y con `#costos`, `#frio`, `#ml`, etc. se abre directamente una pestaña.

## Arquitectura

```
┌──────────────── CMMS (Node.js, puerto 3100) ────────────────┐        ┌──── JDE E1 9.2 ────┐
│ UI web (SPA)  →  API REST  →  servicios de dominio          │        │                    │
│   OTs · plan preventivo · inspección · repuestos · KPIs     │  REST  │  AIS Server        │
│   telemetría IoT + modelo predictivo                        │ ─────► │   tokenrequest     │
│                                                             │        │   orchestrator/*   │
│ Outbox (FIFO, reintentos con espera exponencial) ──────────►│        │        │           │
│ Sincronización entrante cada 60 s ◄─────────────────────────│ ◄───── │  Orquestaciones    │
│ SQLite local (data/flota.db)                                │        │  FLT_* → BSFN/tablas│
└─────────────────────────────────────────────────────────────┘        └────────────────────┘
```

- **Integración saliente (CMMS → JDE):** cada cambio con impacto en el ERP se graba en la tabla `outbox`, en la misma transacción que el cambio local. Un proceso envía los mensajes en orden a `POST /jderest/v3/orchestrator/{nombre}`, autenticado con el token `jde-AIS-Auth` de `POST /jderest/v2/tokenrequest`.
  - Si JDE se cae o hay un timeout, el mensaje queda en `REINTENTO` y se vuelve a intentar con espera exponencial, sin perder ni desordenar mensajes. El taller sigue operando mientras tanto.
  - Si JDE rechaza un mensaje por validación (4xx), queda en `ERROR` para que alguien lo revise.
- **Integración entrante (JDE → CMMS):** JDE es el sistema de registro de los maestros. Cada 60 segundos el CMMS consulta equipos, inventario, estado y costo real de las OTs, y el estado de las compras.

### Mapa de integración

| Proceso | Sentido | Orquestación | Objetos JDE |
|---|---|---|---|
| Ficha de unidad / medidores | JDE → CMMS | `FLT_GetEquipmentList` | P1701 · F1201 |
| Lecturas de odómetro (lote cada 5 min) | CMMS → JDE | `FLT_UpdateMeterReadings` | P12120 |
| Estado de la unidad | CMMS → JDE | `FLT_UpdateEquipmentStatus` | F1201.EQST (UDC 12/ES: AV/IR/DN) |
| Alta de OT | CMMS → JDE | `FLT_CreateWorkOrder` | F4801 (WM), TYPS según tipo de mantenimiento |
| Avance del flujo del taller | CMMS → JDE | `FLT_UpdateWorkOrderStatus` | F4801.SRST (10/20/30/40/80/99) |
| Lista de repuestos / kits A-B-C | CMMS → JDE | `FLT_AddWorkOrderParts` | F3111 |
| Entrega de repuestos | CMMS → JDE | `FLT_IssueParts` | F41021, F4111 (IM) |
| Mano de obra | CMMS → JDE | `FLT_AddLaborHours` | F31122 |
| Cierre y costeo | CMMS → JDE | `FLT_CompleteWorkOrder` | F4801 (99), F0911 (6410 repuestos / 6420 mano de obra) |
| Programación preventiva | CMMS → JDE | `FLT_UpdatePMSchedule` | P1207 · F1207 (PMA/PMB/PMC/PMM) |
| Stock y maestro de repuestos | JDE → CMMS | `FLT_GetInventory` | F4101, F41021 |
| Requisición de compra | CMMS → JDE | `FLT_CreateRequisition` | F4311 (OR) |
| Seguimiento de compras | JDE → CMMS | `FLT_GetRequisitions` | F4311 (OR → OP, 400) |
| Estado y costo real de OTs | JDE → CMMS | `FLT_GetWorkOrders` | F4801 (SRST, HRSA, AMTA) |

> **Para conectarlo a un JDE real:** hay que crear las orquestaciones `FLT_*` en Orchestrator Studio con estas entradas y salidas. Se pueden ver en [jde-mock/server.js](jde-mock/server.js) y en el payload de cada mensaje de la cola. Después se configura la URL del AIS, el usuario, el entorno y el rol en **Integración JDE → Conexión AIS**. El equipo JDE debe validar contra la instalación real:
> - los números de aplicación (P-programs)
> - los códigos UDC (tipos y estados de OT, estado de equipo)
> - las cuentas contables y la sucursal (M30)

## Funcionalidad, según la presentación

| Diapositiva | En el MVP |
|---|---|
| 7 tipos de mantenimiento | Tipo de OT con su código JDE: preventivo, correctivo, predictivo, proactivo, por condición, detectivo y autónomo |
| Sistemas críticos | Catálogo de sistemas. Las fallas en ruta cuentan para el MDBF |
| IoT en la unidad | 12 variables (ECU J1939, refrigerante, aceite, frenos, aire, suspensión, neumáticos, puertas, baterías, batería de tracción) con umbrales y DTC |
| Plan por niveles | Continuo (IoT), diaria (conductor), A/B/C/Mayor por km o tiempo con tolerancia de ±10%. Un nivel superior reinicia los inferiores. Kits automáticos |
| Arquitectura IoT | Sensar → conectar → almacenar → analizar → actuar: la alerta genera la OT y la OT se crea en JDE |
| Predictivo | Tendencia lineal y tiempo estimado hasta el umbral, vida útil de las pastillas, ranking de riesgo, probabilidad de falla a 30 días, MDBF por sistema y fallas recurrentes (proactivo) |
| Flujo del taller | Kanban de 6 etapas con validaciones: el diagnóstico es obligatorio, los repuestos deben estar entregados y un correctivo necesita causa raíz para cerrarse |
| Repuestos | Criticidad A/B/C, stock de seguridad, rotables, requisición automática ante faltantes o stock bajo, y seguimiento OR → OP en JDE |
| KPIs | Disponibilidad, MDBF, MTTR, cumplimiento del preventivo, % planificado, costo por km y disponibilidad esperada (MTBF/(MTBF+MTTR)). Comparación con el período anterior y metas de referencia |

## Recorrido de demostración (unos 10 minutos)

1. **Tablero:** disponibilidad, MDBF, MTTR, cumplimiento del preventivo y costo por km, con el estado de la integración.
2. **Telemetría IoT:** al iniciar, cuatro unidades tienen degradaciones simuladas (recalentamiento, fuga de aire, pinchadura lenta y puerta forzada).
   - En 1 o 2 minutos aparece la **alerta predictiva**, *antes* de que la variable cruce el umbral, y se genera sola la OT predictiva con los repuestos sugeridos. La OT se crea en JDE.
   - Si la variable llega a nivel **crítico**, se genera **siempre** una OT correctiva P1 automática y la unidad queda fuera de servicio (JDE `DN`). Esto no depende del interruptor "OT automática para alertas predictivas y de advertencia". Las críticas no se pueden descartar.
   - Con ⚡ se puede simular una falla en cualquier unidad.
3. **Órdenes de trabajo → una OT:** avanzar por las etapas (diagnóstico → repuestos → entregar → reparación → horas → control → cierre con causa raíz).
   - El panel *Integración JDE* muestra cada orquestación enviada, con su payload y su respuesta.
   - Al cerrar la OT, JDE devuelve el costo real contabilizado en F0911 y la telemetría del sistema reparado vuelve a valores normales.
4. **OT 349 (caja de cambios):** el repuesto falta y hay una requisición abierta en JDE. El JDE simulado recibe la compra a los 45 segundos y, en la siguiente sincronización, el stock aparece en el CMMS.
5. **Plan preventivo → "Generar OTs de vencidos y próximos":** crea las OTs con el kit de cada nivel.
6. **Inspección diaria:** marcar "Falla" en frenos. La unidad queda **no apta**, se crea una OT P1 y su estado en JDE pasa a `DN`.
7. **Integración JDE → "Simular caída de JDE":** seguir operando, ver la cola en *REINTENTO* y luego "Restablecer JDE". La cola se vacía sola y en orden.
8. **http://localhost:8091:** ver las tablas F4801, F3111, F4111, F4311 y F0911 con los registros que generó el CMMS.

## Estructura

```
server/
  index.js            arranque (CMMS + JDE simulado)
  api.js              API REST
  catalog.js          sistemas, tipos, niveles, repuestos, variables IoT, códigos JDE
  seed.js / reset.js  datos de demostración
  jde/aisClient.js    cliente AIS (token, orquestaciones, registro de llamadas)
  jde/integration.js  outbox, reintentos, sincronización entrante
  services/           workorders · pm · telemetry (IoT + predictivo) · kpi
jde-mock/             AIS Server simulado + tablas F en SQLite + visor
public/               interfaz web (módulos ES, gráficos SVG propios, tema claro/oscuro)
data/                 bases SQLite (se generan solas)
```

## Alcance del MVP y próximos pasos

- **JDE simulado:** reproduce los endpoints y las tablas de forma simplificada. El paso siguiente es construir las orquestaciones `FLT_*` en un entorno JDE de prueba (por ejemplo, JDV920) y apuntar la URL del AIS a ese entorno.
- **Telemetría simulada y acelerada:** 1 lectura cada 5 segundos equivale a 1 minuto de operación. En producción se reemplaza por la ingesta desde el gateway a bordo (MQTT o HTTP) hacia una base de series de tiempo.
- **Modelo predictivo heurístico:** tendencia, umbrales e historial. Cuando haya historia suficiente de sensores y OTs, se puede reemplazar por un modelo de ML entrenado sin cambiar la interfaz.
- **Pendiente para producción:**
  - autenticación de usuarios, roles (taller, pañol, jefatura) y auditoría
  - HTTPS y credenciales del AIS en un almacén seguro
  - app móvil para la inspección del conductor
  - montos en la moneda del ERP (el MVP usa USD)
