'use strict';

// ── Driver name pools ──────────────────────────────────────────────
const SHORT_NAMES = [
  'Max V.', 'Lew H.', 'Chas L.', 'Lan N.', 'Car S.', 'Osc P.',
  'Dan R.', 'Val B.', 'Geo R.', 'Pie G.', 'Yuk T.', 'Ale A.',
  'Nik H.', 'Kev M.', 'Est O.', 'Lan S.', 'Gua Z.', 'Fer A.',
];

const NORMAL_NAMES = [
  'Max Verstappen', 'Lewis Hamilton', 'Charles Leclerc', 'Lando Norris',
  'Carlos Sainz', 'Oscar Piastri', 'George Russell', 'Pierre Gasly',
  'Daniel Ricciardo', 'Valtteri Bottas', 'Kevin Magnussen', 'Yuki Tsunoda',
  'Alexander Albon', 'Esteban Ocon', 'Fernando Alonso', 'Nico Hulkenberg',
  'Guanyu Zhou', 'Logan Sargeant', 'Lance Stroll', 'Nyck de Vries',
  'Mick Schumacher', 'Stoffel Vandoorne', 'Robert Kubica', 'Felipe Massa',
  'Jenson Button', 'Kimi Raikkonen', 'Sebastian Vettel', 'Mark Webber',
  'Sergio Perez', 'Romain Grosjean', 'Pastor Maldonado', 'Jean-Eric Vergne',
  'Daniil Kvyat', 'Brendon Hartley', 'Marcus Ericsson', 'Pascal Wehrlein',
  'Antonio Giovinazzi', 'Nikita Mazepin', 'Nicholas Latifi', 'Jack Aitken',
  'Mário Andretti', 'Kazuki Nakajima', 'Kamui Kobayashi', 'Takuma Sato',
  'Heikki Kovalainen', 'Jarno Trulli', 'Rubens Barrichello', 'Juan Pablo Montoya',
];

const LONG_NAMES = [
  'Jean-Éric Vergne-Dupont III', 'Maximilian Gunther-Rosenberg von Hohenstein',
  'Alexander Michael Wurz-Schumacher', 'Pierre-Antoine Gasly-Verstappen',
  'Santiago Urrutia-Montanchez Jr.', 'Konstantinos Papadopoulos-Nikolaidis',
  'Christopher Robin Nygaard-Rasmussen', 'Muhammad Al-Rashid bin Abdullah',
  'Francisco Javier Garcia-Rodriguez', 'Jean-Pierre Jabouille-Beltoise',
];

const COUNTRIES = [
  'Netherlands', 'United Kingdom', 'Monaco', 'Australia', 'Spain', 'France',
  'Finland', 'Germany', 'Japan', 'China', 'Brazil', 'Mexico', 'Italy', 'Canada',
  'Sweden', 'Denmark', 'New Zealand', 'Poland', 'Switzerland', 'Belgium',
];

const CAR_MAKES = {
  'GTP':  ['Porsche 963', 'Cadillac V-Series.R', 'Acura ARX-06', 'BMW M Hybrid V8'],
  'LMP2': ['Dallara P217', 'Oreca 07 LMP2'],
  'GT3 2025':  ['Ferrari 296 GT3', 'Porsche 911 GT3 R', 'BMW M4 GT3', 'McLaren 720S GT3', 'Mercedes AMG GT3', 'Aston Martin Vantage GT3', 'Lamborghini Huracan GT3'],
  'GT4':  ['Porsche 718 GT4', 'BMW M4 GT4', 'McLaren 570S GT4'],
  'TCR':  ['Hyundai Elantra N TC', 'Honda Civic Type R TC'],
};

const CLASS_COLORS = {
  'GTP': '#e80000',
  'LMP2': '#0055ff',
  'GT3 2025': '#ff8800',
  'GT4': '#00cc44',
  'TCR': '#cc44ff',
};

// ── Generator helpers ──────────────────────────────────────────────
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function randInt(lo, hi) { return Math.floor(rand(lo, hi + 1)); }

function generateDriver(idx, className, classColor, namePool) {
  const name = namePool[idx % namePool.length];
  const iRating = randInt(1200, 7500);
  const bestLap = rand(78, 130);
  const lastLap = bestLap + rand(0.1, 2.5);
  return {
    carIdx: idx,
    position: 0,
    classPosition: 0,
    driverName: name,
    carNumber: String(randInt(1, 199)),
    carMake: pick(CAR_MAKES[className] || ['Generic Car']),
    carClass: className,
    carClassColor: classColor,
    safetyRating: ['A 4.99', 'A 3.21', 'B 2.87', 'B 4.12', 'C 3.55', 'C 2.01', 'D 4.50'][idx % 7],
    country: COUNTRIES[idx % COUNTRIES.length],
    clubId: randInt(1, 50),
    license: ['A', 'B', 'C', 'D'][idx % 4] + ' ' + rand(1, 4.99).toFixed(2),
    iRating: iRating,
    startIRating: iRating - randInt(-80, 80),
    bestLap: bestLap,
    lastLap: lastLap,
    inPit: Math.random() < 0.08,
    sessionFlags: 0,
    lapsCompleted: randInt(0, 35),
    estTime: rand(50, 140),
    lapDistPct: Math.random(),
    isPlayer: idx === 0,
    isSpectated: idx === 0,
    tireCompound: 0,
    pitStops: randInt(0, 3),
    lastPitDelta: Math.random() < 0.3 ? rand(25, 55) : 0,
    pitLap: 0,
    pitTimeLive: 0,
    isStopped: false,
    gapToLeader: 0,
    positionGain: randInt(-5, 5),
    disconnected: false,
  };
}

function generateStandings(driverCount, classConfig, namePool) {
  const drivers = [];
  let idx = 0;
  classConfig.forEach(({ name, color, count }) => {
    for (let i = 0; i < count; i++) {
      const d = generateDriver(idx, name, color, namePool);
      d.classPosition = i + 1;
      drivers.push(d);
      idx++;
    }
  });
  // Set overall positions sorted by best lap
  drivers
    .slice()
    .sort((a, b) => (a.bestLap || 999) - (b.bestLap || 999))
    .forEach((d, i) => { d.position = i + 1; });
  // Gap to class leader
  classConfig.forEach(({ name }) => {
    const cls = drivers.filter(d => d.carClass === name);
    if (!cls.length) return;
    const leader = cls[0];
    cls.forEach((d, i) => { d.gapToLeader = i === 0 ? 0 : rand(0.5, i * 4); });
  });
  return drivers;
}

function generateRelative(standings, focusIdx) {
  const focus = standings.find(d => d.carIdx === focusIdx) || standings[0];
  const cars = standings.map(d => ({
    ...d,
    gap: d.carIdx === focusIdx ? 0 : rand(-15, 15),
    distGap: rand(-0.5, 0.5),
  }));
  cars.sort((a, b) => a.gap - b.gap);
  return { playerCarIdx: focusIdx, spectatedCarIdx: focusIdx, cars, focusCar: focus };
}

function generateSession(trackName, eventType, timeRemain, driverCount) {
  return {
    playerCarIdx: 0,
    trackName: trackName,
    airTemp: rand(15, 35),
    trackTemp: rand(25, 55),
    humidity: rand(20, 90),
    trackWetness: 0,
    sessionTime: rand(300, 3600),
    sessionTimeRemain: timeRemain,
    timeOfDay: rand(36000, 72000),
    sof: randInt(1800, 5500),
    sofByClass: { 'GTP': 4200, 'LMP2': 3100, 'GT3 2025': 2500, 'GT4': 1800, 'TCR': 1500 },
    incidentCount: randInt(0, 12),
    fogLevel: rand(0, 0.3),
    precipitation: rand(0, 0.4),
    weatherWet: false,
    skies: pick(['Clear', 'Partly Cloudy', 'Mostly Cloudy', 'Overcast', 'Dynamic']),
    weatherType: 'Constant',
    windDir: rand(0, 6.28),
    windSpeed: rand(0, 12),
    fuelLevel: rand(10, 80),
    waterTemp: rand(80, 105),
    oilTemp: rand(90, 120),
    sessionLapsRemain: 0,
    eventType: eventType,
    sessionNum: 2,
    stintLaps: randInt(0, 20),
    stintTime: rand(0, 1800),
    playerIRChange: randInt(-60, 60),
    pitDeltas: {
      'GTP': { avgDelta: 38.2, samples: 6 },
      'LMP2': { avgDelta: 42.1, samples: 4 },
      'GT3 2025': { avgDelta: 48.5, samples: 12 },
    },
    overtakesByClass: { 'GTP': 3, 'LMP2': 7, 'GT3 2025': 15 },
    fuelPerLap: rand(1.5, 4.2),
    fuelCapacity: rand(80, 120),
    drivers: [],
  };
}

function generateFlags(scenarioName) {
  switch (scenarioName) {
    case 'empty':
      return { activeFlag: null, since: null, rawBits: 0 };
    case 'minimal':
      return { activeFlag: 'green', since: Date.now(), rawBits: 0x4 };
    case 'extreme':
      return { activeFlag: 'black', since: Date.now(), rawBits: 0x10000 };
    default:
      return { activeFlag: 'yellow', since: Date.now(), rawBits: 0x8 };
  }
}

function generateFuel() {
  const avgPerLap = rand(1.8, 3.5);
  const fuelLevel = rand(15, 75);
  return {
    fuelLevel,
    fuelPct: fuelLevel / 110,
    fuelUsePerHour: avgPerLap * 40,
    avgPerLap,
    avg5Laps: avgPerLap + rand(-0.2, 0.2),
    avg10Laps: avgPerLap + rand(-0.15, 0.15),
    minUsage: avgPerLap - rand(0.1, 0.4),
    maxUsage: avgPerLap + rand(0.2, 0.6),
    lapsOfFuel: fuelLevel / avgPerLap,
    lapsRemaining: randInt(15, 45),
    fuelToFinish: rand(20, 80),
    fuelToAdd: rand(0, 40),
    lapsCompleted: randInt(5, 30),
    lapCount: randInt(5, 30),
    avgLapTime: rand(78, 130),
  };
}

function generateWind() {
  return { windDirection: rand(0, 6.28), windSpeed: rand(0, 15), carHeading: rand(0, 6.28) };
}

function generateInputs() {
  return { throttle: rand(0, 1), brake: rand(0, 0.3), clutch: 1, steer: rand(-0.5, 0.5), gear: randInt(2, 6), speed: rand(20, 80) };
}

function generateTrackmap(standings) {
  // Simple oval path
  const path = [];
  for (let i = 0; i < 300; i++) {
    const t = (i / 300) * Math.PI * 2;
    path.push({ x: Math.cos(t) * 0.01 - 89.4, y: Math.sin(t) * 0.005 + 43.5 });
  }
  return {
    trackPath: path,
    trackPathReady: true,
    cars: standings.map(d => ({
      carIdx: d.carIdx, pct: d.lapDistPct, carNumber: d.carNumber,
      carMake: d.carMake, carClass: d.carClass, carClassColor: d.carClassColor,
      isPlayer: d.isPlayer, isSpectated: d.isSpectated, inPit: d.inPit,
    })),
    playerCarIdx: 0,
  };
}

// ── Scenarios ──────────────────────────────────────────────────────

const CLASS_3 = [
  { name: 'GTP', color: CLASS_COLORS.GTP, count: 4 },
  { name: 'LMP2', color: CLASS_COLORS.LMP2, count: 6 },
  { name: 'GT3 2025', color: CLASS_COLORS['GT3 2025'], count: 20 },
];

const CLASS_5 = [
  { name: 'GTP', color: CLASS_COLORS.GTP, count: 4 },
  { name: 'LMP2', color: CLASS_COLORS.LMP2, count: 6 },
  { name: 'GT3 2025', color: CLASS_COLORS['GT3 2025'], count: 20 },
  { name: 'GT4', color: CLASS_COLORS.GT4, count: 12 },
  { name: 'TCR', color: CLASS_COLORS.TCR, count: 10 },
];

const CLASS_1 = [
  { name: 'GT3 2025', color: CLASS_COLORS['GT3 2025'], count: 3 },
];

function buildScenario(name) {
  let standings, namePool;
  switch (name) {
    case 'extreme': {
      namePool = LONG_NAMES.concat(LONG_NAMES, LONG_NAMES, LONG_NAMES, LONG_NAMES, LONG_NAMES);
      standings = generateStandings(52, CLASS_5, namePool);
      break;
    }
    case 'minimal': {
      namePool = SHORT_NAMES;
      standings = generateStandings(3, CLASS_1, namePool);
      break;
    }
    case 'empty': {
      return {
        standings: [],
        session: generateSession('--', 'Practice', 0, 0),
        fuel: { fuelLevel: 0, fuelPct: 0, avgPerLap: 0, avg5Laps: 0, avg10Laps: 0, minUsage: 0, maxUsage: 0, lapsOfFuel: 0, lapsRemaining: 0, fuelToFinish: 0, fuelToAdd: 0, lapsCompleted: 0, lapCount: 0, avgLapTime: 0 },
        wind: { windDirection: 0, windSpeed: 0, carHeading: 0 },
        inputs: { throttle: 0, brake: 0, clutch: 1, steer: 0, gear: 0, speed: 0 },
        relative: { playerCarIdx: 0, spectatedCarIdx: 0, cars: [], focusCar: null },
        trackmap: { trackPath: [], trackPathReady: false, cars: [], playerCarIdx: 0 },
        proximity: { carLeftRight: 0 },
        flags: generateFlags('empty'),
      };
    }
    case 'deep-field': {
      namePool = NORMAL_NAMES;
      const bigClass = [{ name: 'GT3 2025', color: CLASS_COLORS['GT3 2025'], count: 50 }];
      standings = generateStandings(50, bigClass, namePool);
      // Move player to position 42
      standings.forEach(d => { d.isPlayer = false; d.isSpectated = false; });
      standings[41].isPlayer = true;
      standings[41].isSpectated = true;
      standings[41].classPosition = 42;
      break;
    }
    case 'deep-field-multi': {
      namePool = NORMAL_NAMES;
      const multiClass = [
        { name: 'GTP', color: CLASS_COLORS.GTP, count: 4 },
        { name: 'LMP2', color: CLASS_COLORS.LMP2, count: 8 },
        { name: 'GT3 2025', color: CLASS_COLORS['GT3 2025'], count: 40 },
      ];
      standings = generateStandings(52, multiClass, namePool);
      // Move player to P35 in GT3
      standings.forEach(d => { d.isPlayer = false; d.isSpectated = false; });
      const gt3Drivers = standings.filter(d => d.carClass === 'GT3 2025');
      if (gt3Drivers[34]) {
        gt3Drivers[34].isPlayer = true;
        gt3Drivers[34].isSpectated = true;
        gt3Drivers[34].classPosition = 35;
      }
      break;
    }
    default: { // 'normal'
      namePool = NORMAL_NAMES;
      standings = generateStandings(30, CLASS_3, namePool);
    }
  }
  return {
    standings,
    session: generateSession('Circuit de Spa-Francorchamps', 'Race', 2400, standings.length),
    fuel: generateFuel(),
    wind: generateWind(),
    inputs: generateInputs(),
    relative: generateRelative(standings, 0),
    trackmap: generateTrackmap(standings),
    proximity: { carLeftRight: rand(-0.3, 0.3) },
    flags: generateFlags(name),
  };
}

// ── Channel → overlay mapping ──────────────────────────────────────
const OVERLAY_CHANNELS = {
  standings:    ['standings', 'session'],
  relative:     ['relative', 'session'],
  fuel:         ['fuel'],
  wind:         ['wind'],
  inputs:       ['inputs'],
  trackmap:     ['trackmap', 'wind'],
  weather:      ['session'],
  raceduration: ['session', 'standings'],
  flags:        ['flags'],
  drivercard:   ['standings'],
  stintlaps:    ['standings', 'session'],
  livestats:    ['standings', 'session'],
  pitstrategy:  ['session', 'standings'],
  pittimer:     ['standings'],
  lapcompare:   ['standings'],
  proximity:    ['proximity'],
  chat:         [],
  voicechat:    [],
  discord:      [],
};

module.exports = { buildScenario, OVERLAY_CHANNELS, CLASS_COLORS };
