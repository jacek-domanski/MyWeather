const dataKey = 'data';
const storingDateKey = 'storingDay';

// Superseded by placesKey, but still read once so that names and coordinates
// set before the collection existed are carried over instead of lost.
const legacyNamesKey = 'placeNames';
const legacyCoordinatesKey = 'placeCoordinates';

const placesKey = 'places';

// The API reports rainfall in mm but snowfall as snow DEPTH in cm. Snow density
// depends on the temperature, so this is only an estimate of the water
// equivalent, but it keeps both series on a single comparable axis.
const SNOW_DEPTH_CM_TO_MM_WATER = 1;

// Fields every cached payload must contain to be reusable. Caches written
// before rain/snowfall were requested are missing 'rain'/'snowfall' and must be
// treated as stale even when their date range still looks current.
const REQUIRED_HOURLY_FIELDS = ['time', 'temperature_2m', 'rain', 'snowfall'];

// Shared by the axis ticks, the place names and the rename input so all text on
// the page reads as the same gray. The coordinates rest a shade darker and
// lighten to this same gray while being edited.
const LABEL_COLOR = '#aaaaaa';
const LABEL_FONT = 'Lato, sans-serif';
const COORDINATES_COLOR = '#3b3b3b';
const COORDINATES_FONT_SIZE = '13px';

const CONTROL_COLOR = '#888888';

// Fixed so the label row cannot change height as text changes, which keeps the
// two canvases in a row aligned even while a webfont is loading.
const LABEL_HEIGHT = '24px';

const CHART_GAP = '40px';

const DEFAULT_PLACES = [
  { id: 'cracow', name: 'Cracow', latitude: 50.0614, longitude: 19.9366 },
  { id: 'tenerife', name: 'Tenerife', latitude: 28.411515, longitude: -16.535813 }
];

let places = [];
let chartInstances = [];
let nextPlaceId = 1;

// Incremented on every render. A render whose token is stale by the time it
// resumes after an await must not draw, or a slow fetch for one place can land
// after the user has already added, removed or reordered something.
let renderToken = 0;

async function main() {
  places = loadPlaces();
  renderPageControls();
  await render();
}

// --- collection ---------------------------------------------------------------

function isValidLatitude(value) {
  return typeof value === 'number' && isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return typeof value === 'number' && isFinite(value) && value >= -180 && value <= 180;
}

function toRecord(place) {
  return {
    id: place.id,
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    pending: place.pending === true
  };
}

function toPlace(record, takenIds) {
  let id = record.id;
  let name = typeof record.name === 'string' ? record.name : 'New location';

  let latitude = isValidLatitude(record.latitude) ? record.latitude : 0;
  let longitude = isValidLongitude(record.longitude) ? record.longitude : 0;

  // A place added by the plus button has no location yet, so it must not be
  // fetched until coordinates are given. Derive that from the record too, so a
  // reload does not turn a placeholder into a real fetch.
  let // 'pending' is authoritative rather than derived from the coordinates: a
  // freshly added place starts at 0,0, which are themselves valid values, so
  // they cannot stand in for "no location yet".
  let pending = record.pending === true
    || !isValidLatitude(record.latitude)
    || !isValidLongitude(record.longitude);

  // Ids key the cache, so a duplicate left in storage would let two places
  // read each other's data.
  let uniqueId = id;
  if (typeof id !== 'string' || id === '' || takenIds.has(uniqueId)) {
    uniqueId = generatePlaceId(takenIds);
  }
  takenIds.add(uniqueId);

  return new Place(uniqueId, name, latitude, longitude, pending);
}

// Ids are derived from the clock and a counter so that reloading cannot produce
// two places sharing an id.
function generatePlaceId(takenIds) {
  while (true) {
    let id = 'place-' + Date.now().toString(36) + '-' + nextPlaceId;
    nextPlaceId++;
    if (!takenIds.has(id)) return id;
  }
}

function loadPlaces() {
  let stored = localStorage.getItem(placesKey);

  if (stored !== null) {
    let parsed = parseJson(stored);

    if (Array.isArray(parsed)) {
      let takenIds = new Set();
      let records = parsed.filter(record => record !== null && typeof record === 'object');
      let loaded = records.map(record => toPlace(record, takenIds));

      // An empty stored list is a genuine choice: every place was deleted. But a
      // non-empty list that yields no usable records is corruption, and falling
      // back to the defaults recovers from it instead of showing an empty page.
      if (loaded.length > 0 || parsed.length === 0) return loaded;

      console.warn('Discarding unusable stored place collection');
    }
  }

  // First run of this version: seed the defaults, carrying over anything set
  // through the older name and coordinate overrides.
  let seeded = DEFAULT_PLACES.map(record => toPlace(record, new Set()));
  applyLegacyOverrides(seeded);
  savePlaces(seeded);

  return seeded;
}

function applyLegacyOverrides(loaded) {
  let names = loadObjectStore(legacyNamesKey, 'place names');
  let coordinates = loadObjectStore(legacyCoordinatesKey, 'place coordinates');

  loaded.forEach(place => {
    let name = names[place.id];
    if (typeof name === 'string' && name.trim() !== '') place.name = name;

    let coordinatesEntry = coordinates[place.id];
    if (coordinatesEntry === null || typeof coordinatesEntry !== 'object') return;

    let latitude = Number(coordinatesEntry.latitude);
    let longitude = Number(coordinatesEntry.longitude);

    if (isValidLatitude(latitude) && isValidLongitude(longitude)) {
      place.latitude = latitude;
      place.longitude = longitude;
      place.pending = false;
    }
  });
}

function savePlaces(collection) {
  localStorage.setItem(placesKey, JSON.stringify(collection.map(toRecord)));
}

function addPlace() {
  let takenIds = new Set(places.map(place => place.id));
  let place = new Place(generatePlaceId(takenIds), 'New location', 0, 0, true);

  places.push(place);
  savePlaces(places);

  return place;
}

function deletePlace(place) {
  let index = places.indexOf(place);
  if (index === -1) return false;

  places.splice(index, 1);

  // Drop the cached weather too, otherwise it stays in storage forever with
  // nothing left referencing it.
  localStorage.removeItem(place.id);

  savePlaces(places);

  return true;
}

function movePlace(place, offset) {
  let from = places.indexOf(place);
  let to = from + offset;

  if (from === -1 || to < 0 || to >= places.length) return false;

  places.splice(from, 1);
  places.splice(to, 0, place);

  savePlaces(places);

  return true;
}

// --- storage helpers ----------------------------------------------------------

function parseJson(stored) {
  try {
    return JSON.parse(stored);
  } catch (error) {
    return undefined;
  }
}

function loadObjectStore(key, description) {
  let stored = localStorage.getItem(key);
  if (stored === null) return {};

  let parsed = parseJson(stored);

  if (parsed === undefined) {
    console.warn('Discarding unreadable stored ' + description);
    localStorage.removeItem(key);
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  return parsed;
}

function formatCoordinates(place) {
  return place.latitude.toFixed(4) + ', ' + place.longitude.toFixed(4);
}

// Strictly "latitude, longitude", matching both the Open-Meteo parameter order
// and the order the coordinates are displayed in. The two orders are not
// distinguishable from the text alone (91 is a valid longitude), so an
// out-of-order or out-of-range value is rejected rather than guessed at: a
// silently relocated place is far worse than a refused edit.
function parseCoordinates(text) {
  let parts = text.split(',').map(part => part.trim()).filter(part => part !== '');

  if (parts.length !== 2) return null;

  let numbers = parts.map(part => Number(part));
  if (numbers.some(value => !isFinite(value))) return null;

  let [latitude, longitude] = numbers;

  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;

  return { latitude: latitude, longitude: longitude };
}

function hasRequiredFields(rawData) {
  if (rawData === null || typeof rawData !== 'object') return false;

  let hourly = rawData['hourly'];
  if (hourly === null || typeof hourly !== 'object') return false;

  return REQUIRED_HOURLY_FIELDS.every(field => hourly[field] !== undefined);
}

function readCachedData(place) {
  let cached = localStorage.getItem(place.id);
  if (cached === null) return null;

  let entry = parseJson(cached);

  if (entry === undefined) {
    // A truncated or non-JSON entry would otherwise abort the whole run.
    console.warn('Discarding unreadable cached data for ' + place.name);
    localStorage.removeItem(place.id);
    return null;
  }

  // Entries are stored wrapped with the coordinates they were fetched for. A
  // bare payload, or one for different coordinates, means the place was moved
  // and the data no longer describes it.
  if (entry === null || typeof entry !== 'object' || entry['data'] === undefined) {
    localStorage.removeItem(place.id);
    return null;
  }

  let rawData = entry['data'];

  if (entry['coordinates'] !== formatCoordinates(place)) return null;
  if (!hasRequiredFields(rawData) || !isDataUpToDate(rawData)) return null;

  return rawData;
}

function isDataUpToDate(rawData){
  let lastDataDate = new Date(rawData['hourly']['time'][rawData['hourly']['time'].length-1]);

  let yesterday = new Date(Date.now());
  yesterday.setDate(yesterday.getDate()-1);

  if (lastDataDate.getDate() != yesterday.getDate()) return false;

  if (lastDataDate.getMonth() != yesterday.getMonth()) return false;

  if (lastDataDate.getFullYear() != yesterday.getFullYear()) return false;
  
  return true;
}

async function fetchWeatherData(place){
  let url = place.fetchUrl();

  try {
    let rawData = await fetch(url)
    .then(response => {
      // Check if the response status is OK (status code 200)
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      return response.json();
    });

    storeData(rawData, place);
    return rawData;
  } catch (error) {
    // Return null instead of undefined so callers can tell "failed" from "empty".
    console.error('Fetch error:', error);
    return null;
  }
}

function storeData(rawData, place){
  if (rawData === null || rawData === undefined) return;

  // Stored with the coordinates it was fetched for, so editing a place's
  // location invalidates the entry instead of showing the old area's weather.
  let entry = { coordinates: formatCoordinates(place), data: rawData };
  localStorage.setItem(place.id, JSON.stringify(entry));
  localStorage.setItem(storingDateKey, Date.now());
}

// --- aggregation --------------------------------------------------------------

function calculateValuesForDays(rawData) {
  let hourly = rawData['hourly'];
  let daysData = [];

  // Both charts are derived from the same buckets, so their day boundaries can
  // never disagree.
  groupHoursByDay(hourly).forEach(group => {
    let temperatures = group.indices.map(i => hourly['temperature_2m'][i]);
    let dayData = calculateThisDayValues(group.day, temperatures);

    calculatePrecipitationForDay(dayData, group.indices, hourly);

    daysData.push(dayData);
  });

  calculateTrend(daysData);
  return daysData;
}

function groupHoursByDay(hourly) {
  let times = hourly['time'];
  let groups = [];

  for (let i = 0; i < times.length; i++) {
    let day = new Date(times[i]).getDate();

    if (groups.length === 0 || groups[groups.length - 1].day !== day) {
      groups.push({ day: day, indices: [] });
    }

    groups[groups.length - 1].indices.push(i);
  }

  return groups;
}

function calculatePrecipitationForDay(dayData, indices, hourly) {
  let rainSum = 0;
  let snowDepthCm = 0;

  indices.forEach(i => {
    rainSum += hourly['rain'][i];
    snowDepthCm += hourly['snowfall'][i];
  });

  // The API's own 'precipitation' field is not rain + snowfall (it stays above
  // zero in hours where both are zero), so values are derived per field.
  dayData.setPrecipitation(rainSum, snowDepthCm * SNOW_DEPTH_CM_TO_MM_WATER);
}

function calculateThisDayValues(day, daysTemperatures) {
  daysTemperatures.sort(function(a, b){return a-b});

  let minimum = daysTemperatures[0];
  let maximum = daysTemperatures[daysTemperatures.length - 1];
  let count = daysTemperatures.length;
  let median;
  if (count % 2 == 0) {
    let middleA = daysTemperatures[count / 2];
    let middleB = daysTemperatures[(count / 2) - 1];
    median = 0.5 * (middleA + middleB);
  } else {
    median = daysTemperatures[Math.floor(0.5 * count)];
  }

  let sum = 0;
  daysTemperatures.forEach(t => sum += t);
  let average = sum / count;
  return new DayData(day, minimum, maximum, average, median)
}

function calculateTrend(daysData) {
  let daysSum = 0;
  let temperaturesSum = 0;
  for (let i = 0; i < daysData.length; i++) {
    daysSum += i;
    temperaturesSum += daysData[i].average;
  }
  let daysAverage = daysSum / daysData.length;
  let temperaturesAverage = temperaturesSum / daysData.length;
  let numerator = 0;
  let denominator = 0;
  
  for (let i = 0; i < daysData.length; i++) {
    numerator += (i - daysAverage) * (daysData[i].average - temperaturesAverage);
    denominator += (i - daysAverage) * (i - daysAverage);
  }
  let slope = numerator / denominator;
  let yOffset = temperaturesAverage - (slope * daysAverage);

  for (let i = 0; i < daysData.length; i++) {
    let trend = (slope * i) + yOffset;;
    daysData[i].setTrend(trend);
  }
}

// --- rendering ----------------------------------------------------------------

function chartScales(beginAtZero) {
  return {
    // Explicit font, because Chart.js inherits the canvas font rather than the
    // surrounding document's.
    font: { family: LABEL_FONT },
    scales: {
      y: {
        beginAtZero: beginAtZero,
        position: 'right',
        ticks: {
          color: LABEL_COLOR,
        }
      },
      x: {
        ticks: {
          color: LABEL_COLOR,
        }
      }
    }
  };
}

function destroyCharts() {
  chartInstances.forEach(chart => {
    try {
      chart.destroy();
    } catch (error) {
      console.warn('Failed to discard a chart', error);
    }
  });

  chartInstances = [];
}

async function render() {
  let token = ++renderToken;

  destroyCharts();

  let container = document.getElementById('charts');
  container.innerHTML = '';

  for (let i = 0; i < places.length; i++) {
    let place = places[i];

    // A place added by the plus button has no coordinates yet, so it gets a row
    // with a prompt instead of a chart.
    if (place.pending) {
      container.appendChild(createPendingRow(place));
      continue;
    }

    let rawData = readCachedData(place);

    if (rawData === null) {
      rawData = await fetchWeatherData(place);

      if (rawData === null) {
        console.error('Skipping ' + place.name + ' - no data available');
        continue;
      }
    }

    // The collection may have changed while this fetch was in flight.
    if (token !== renderToken) return;

    container.appendChild(createChartRow(place, calculateValuesForDays(rawData)));
  }

  if (token !== renderToken) return;

  updateControlStates();
}

// Chart instances are tracked so they can be destroyed before a redraw. Without
// this, every reorder or delete would leave orphaned charts bound to canvases
// that are about to be discarded.
function createChart(canvas, config) {
  let chart = new Chart(canvas, config);
  chartInstances.push(chart);
  return chart;
}

function plotTemperatureChart(canvas, daysData) {
  createChart(canvas, {
    type: 'line',
    data: {
      labels: daysData.map(element => element.day),
      datasets: [{
        label: 'Minimum',
        data: daysData.map(element => element.minimum),
        borderWidth: 1
      },{
        label: 'Maximum',
        data: daysData.map(element => element.maximum),
        borderWidth: 1
      },{
        label: 'Average',
        data: daysData.map(element => element.average),
        borderWidth: 1
      },{
        label: 'Median',
        data: daysData.map(element => element.median),
        borderWidth: 1
      },{
        label: 'Trend',
        data: daysData.map(element => element.trend),
        borderWidth: 1,
        pointRadius: 1,
      },]
    },
    options: chartScales(false)
  });
}

function plotPrecipitationChart(canvas, daysData) {
  // One dataset per quantity, so Chart.js draws them side by side and a day
  // with no snow simply shows a single rain bar.
  createChart(canvas, {
    type: 'bar',
    data: {
      labels: daysData.map(element => element.day),
      datasets: [{
        label: 'Rain (mm)',
        data: daysData.map(element => element.rain),
        backgroundColor: 'rgba(54, 162, 235, 0.6)',
        borderColor: 'rgba(54, 162, 235, 1)',
      },{
        label: 'Snow (mm water equivalent)',
        data: daysData.map(element => element.snow),
        backgroundColor: 'rgba(231, 222, 231, 0.6)',
        borderColor: 'rgba(231, 222, 231, 1)',
      },]
    },
    options: chartScales(true)
  });
}

// One row per place, holding both charts side by side. Keeping them in a single
// flex row rather than in two parallel columns is what keeps them aligned: the
// row owns the height, so a placeholder row or a taller chart cannot push one
// side out of step with the other.
function createChartRow(place, daysData) {
  let row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = CHART_GAP;

  let temperature = createChartBlock(place, place.id, true, daysData);
  let precipitation = createChartBlock(place, place.id + '-precipitation', false, daysData);

  row.appendChild(temperature.block);
  row.appendChild(precipitation.block);

  plotTemperatureChart(temperature.canvas, daysData);
  plotPrecipitationChart(precipitation.canvas, daysData);

  return row;
}

function createPendingRow(place) {
  let row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = CHART_GAP;

  let block = createChartBlock(place, place.id, true, null);
  block.block.appendChild(createPendingHint());

  // The empty right-hand block keeps the row the same shape as a full one.
  let spacer = createChartBlock(place, place.id + '-precipitation', false, null);

  row.appendChild(block.block);
  row.appendChild(spacer.block);

  return row;
}

function createPendingHint() {
  let hint = document.createElement('div');
  hint.textContent = 'Click the coordinates to set a location';
  hint.style.color = COORDINATES_COLOR;
  hint.style.fontFamily = LABEL_FONT;
  hint.style.fontSize = COORDINATES_FONT_SIZE;

  return hint;
}

// Creates the container that keeps a place's label and canvas together.
//
// Both sides get a label row even where the name is not shown, so the two
// canvases in a row start at the same offset. The precipitation side therefore
// renders an invisible spacer of the same fixed height.
function createChartBlock(place, canvasId, showLabel, daysData) {
  let block = document.createElement('div');
  block.style.flex = '1';
  block.style.minWidth = '0';

  let label = createNameLabel(place, showLabel);
  block.appendChild(label);

  if (daysData === null) return { block: block, canvas: null };

  let canvas = document.createElement('canvas');
  canvas.id = canvasId;
  block.appendChild(canvas);

  return { block: block, canvas: canvas };
}

function createNameLabel(place, visible) {
  let label = document.createElement('div');
  label.style.height = LABEL_HEIGHT;
  label.style.lineHeight = LABEL_HEIGHT;
  label.style.color = LABEL_COLOR;
  label.style.fontFamily = LABEL_FONT;
  label.style.fontSize = '18px';
  label.style.marginBottom = '8px';
  label.style.display = 'flex';
  label.style.alignItems = 'center';
  label.style.gap = '10px';

  if (!visible) {
    // Invisible spacer holding the row open, so both canvases start at the
    // same offset from the top of the row.
    label.style.visibility = 'hidden';
    label.setAttribute('aria-hidden', 'true');
    return label;
  }

  label.appendChild(createNameField(place));
  label.appendChild(createCoordinatesField(place));
  label.appendChild(createPlaceControls(place));

  return label;
}

// Wires a span to be click- and keyboard-editable. Both fields behave the same
// way, so the activation handling lives here rather than being repeated.
function makeEditable(span, description, onActivate) {
  span.style.cursor = 'text';
  span.title = 'Click to edit the ' + description;
  span.tabIndex = 0;

  span.addEventListener('click', event => {
    // A click that lands on the input inside this span is handled by the
    // editor itself; treating it as activation would restart the edit.
    if (event.target === span) onActivate();
  });

  span.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate();
    }
  });

  return span;
}

function createNameField(place) {
  let span = document.createElement('span');
  span.textContent = place.name;

  return makeEditable(span, 'location name', () => startEditingName(place, span));
}

function createCoordinatesField(place) {
  let span = document.createElement('span');
  span.id = 'coordinates-' + place.id;
  span.textContent = place.pending ? 'set location' : formatCoordinates(place);
  span.style.color = COORDINATES_COLOR;
  span.style.fontSize = COORDINATES_FONT_SIZE;

  return makeEditable(span, 'coordinates', () => startEditingCoordinates(place, span));
}

// Reorder and delete controls, aligned to the right of the label row.
function createPlaceControls(place) {
  let container = document.createElement('span');
  container.className = 'placeControls';
  container.style.marginLeft = 'auto';
  container.style.display = 'flex';
  container.style.gap = '4px';

  container.appendChild(createControlButton('▲', 'Move up', 'moveUp', place.id,
    () => { movePlace(place, -1); render(); }));
  container.appendChild(createControlButton('▼', 'Move down', 'moveDown', place.id,
    () => { movePlace(place, 1); render(); }));
  container.appendChild(createControlButton('−', 'Delete this location', 'delete', place.id,
    () => { deletePlace(place); render(); }));

  return container;
}

function createControlButton(symbol, title, action, placeId, onClick) {
  let button = document.createElement('button');
  button.type = 'button';
  button.textContent = symbol;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.action = action;
  button.dataset.placeId = placeId;

  styleControlButton(button);

  button.addEventListener('click', onClick);

  return button;
}

function styleControlButton(button) {
  button.style.color = CONTROL_COLOR;
  button.style.backgroundColor = 'transparent';
  button.style.border = '1px solid #444444';
  button.style.borderRadius = '3px';
  button.style.fontFamily = LABEL_FONT;
  button.style.fontSize = '13px';
  button.style.lineHeight = '1';
  button.style.padding = '3px 7px';
  button.style.cursor = 'pointer';
}

function renderPageControls() {
  let container = document.getElementById('pageControls');
  container.innerHTML = '';

  container.appendChild(createControlButton('+', 'Add a location', 'add', '', () => {
    let place = addPlace();

    render().then(() => {
      // Open the coordinates field, since that is what the new place still
      // needs. Skipped if the user re-triggered a render in the meantime.
      let field = document.getElementById('coordinates-' + place.id);
      if (field !== null) startEditingCoordinates(place, field);
    });
  }));
}

// The move buttons depend on the current order and count, so their enabled state
// is recomputed on every render rather than baked in at creation.
function updateControlStates() {
  document.querySelectorAll('button[data-action]').forEach(button => {
    let action = button.dataset.action;
    if (action === 'add') return;

    let index = places.findIndex(place => place.id === button.dataset.placeId);
    if (index === -1) return;

    let first = index === 0;
    let last = index === places.length - 1;

    button.disabled = (action === 'moveUp' && first) || (action === 'moveDown' && last);
    button.style.opacity = button.disabled ? '0.3' : '1';
    button.style.cursor = button.disabled ? 'default' : 'pointer';
  });
}

// --- inline editing -----------------------------------------------------------

// Shared by the name and coordinate editors: swaps a span for a text input and
// resolves exactly once, whether via Enter, blur or Escape.
function startEditing(span, currentValue, options) {
  // Guard against a second click stacking a second input in the same span.
  if (span.querySelector('input') !== null) return;

  let input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue;
  input.style.color = options.editingColor;
  input.style.backgroundColor = 'transparent';
  input.style.border = '1px solid #555555';
  input.style.fontFamily = LABEL_FONT;
  input.style.fontSize = options.fontSize;
  input.style.width = options.inputWidth;

  span.textContent = '';
  span.appendChild(input);
  input.focus();
  input.select();

  let finished = false;

  function commit() {
    if (finished) return;
    finished = true;
    options.onCommit(input.value.trim());
  }

  function cancel() {
    if (finished) return;
    finished = true;
    options.onCancel();
  }

  input.addEventListener('keydown', event => {
    // The input lives inside the span, which has its own keydown handler for
    // activating the editor. Without stopping propagation, a keystroke here
    // bubbles up and re-triggers it: the span's Space handling would
    // preventDefault and swallow the character, and its Enter handling would
    // reopen the editor moments after this one closed it.
    event.stopPropagation();

    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });

  // Escape cancels but still fires blur, so the guard above keeps the cancelled
  // edit from being committed. Blur is stopped for the same reason as keydown:
  // a click on the span must not be seen as activating the editor.
  input.addEventListener('blur', event => {
    event.stopPropagation();
    commit();
  });
}

function startEditingName(place, span) {
  startEditing(span, place.name, {
    editingColor: LABEL_COLOR,
    fontSize: '18px',
    inputWidth: '300px',
    onCancel: () => { span.textContent = place.name; },
    onCommit: value => {
      // A blank name is treated as "no change" so a place is never left unnamed.
      if (value === '' || value === place.name) {
        span.textContent = place.name;
        return;
      }

      place.name = value;
      savePlaces(places);
      span.textContent = value;
    },
  });
}

function startEditingCoordinates(place, span) {
  startEditing(span, place.pending ? '' : formatCoordinates(place), {
    editingColor: LABEL_COLOR,
    fontSize: COORDINATES_FONT_SIZE,
    inputWidth: '180px',
    onCancel: () => {
      span.textContent = place.pending ? 'set location' : formatCoordinates(place);
      span.style.color = COORDINATES_COLOR;
    },
    onCommit: value => {
      let parsed = parseCoordinates(value);

      if (parsed === null) {
        console.warn('Ignoring invalid coordinates "' + value + '"');
        span.textContent = place.pending ? 'set location' : formatCoordinates(place);
        span.style.color = COORDINATES_COLOR;
        return;
      }

      place.latitude = parsed.latitude;
      place.longitude = parsed.longitude;
      place.pending = false;

      savePlaces(places);

      // The cached payload belongs to the old position, so drop it and redraw.
      localStorage.removeItem(place.id);

      render();
    },
  });
}

main();