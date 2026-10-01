const dataKey = 'data';
const storingDateKey = 'storingDay';
const namesKey = 'placeNames';
const coordinatesKey = 'placeCoordinates';

// Coordinates are shown next to the name as deliberately quiet text, and lighten
// to the normal label gray only while being edited.
const COORDINATES_COLOR = '#3b3b3b';
const COORDINATES_FONT_SIZE = '13px';

// The API reports rainfall in mm but snowfall as snow DEPTH in cm. Snow density
// depends on the temperature, so this is only an estimate of the water
// equivalent, but it keeps both series on a single comparable axis.
const SNOW_DEPTH_CM_TO_MM_WATER = 1;

// Fields every cached payload must contain to be reusable. Caches written
// before rain/snowfall were requested are missing 'rain'/'snowfall' and must be
// treated as stale even when their date range still looks current.
const REQUIRED_HOURLY_FIELDS = ['time', 'temperature_2m', 'rain', 'snowfall'];

// Shared by the axis ticks, the place names and the rename input so all text on
// the page reads as the same gray. COORDINATES_EDITING_COLOR is this same gray,
// which the coordinates lighten to while being edited.
const LABEL_COLOR = '#aaaaaa';
const LABEL_FONT = 'Lato, sans-serif';

let places = []

async function main() {
  places.push(new Place('cracow', 'Cracow', 50.0614, 19.9366));
  places.push(new Place('tenerife', 'Tenerife', 28.411515, -16.535813));
  applyStoredNames();
  applyStoredCoordinates();

  for (let i = 0; i < places.length; i++) {
    let place = places[i];
    let rawData = readCachedData(place);

    if (rawData === null) {
      rawData = await fetchWeatherData(place);

      // The request failed. Nothing is cached in that case, so a later visit can
      // still recover; skip this place for now.
      if (rawData === null) {
        console.error('Skipping ' + place.name + ' - no data available');
        continue;
      }

      console.log('Downloading new data for ' + place.name);
    } else {
      console.log('Using existing data for ' + place.name);
    }

    let daysData = calculateValuesForDays(rawData);
    plotData(place, daysData);
    plotPrecipitationData(place, daysData);
  }
}

function loadNameOverrides() {
  return loadObjectStore(namesKey, 'place names');
}

function saveName(place, name) {
  let overrides = loadNameOverrides();
  overrides[place.id] = name;
  localStorage.setItem(namesKey, JSON.stringify(overrides));
}

function applyStoredNames() {
  let overrides = loadNameOverrides();

  places.forEach(place => {
    let stored = overrides[place.id];
    if (typeof stored === 'string' && stored.trim() !== '') {
      place.name = stored;
    }
  });
}

function loadObjectStore(key, description) {
  let stored = localStorage.getItem(key);
  if (stored === null) return {};

  let parsed;

  try {
    parsed = JSON.parse(stored);
  } catch (error) {
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

  if (!isLatitude(latitude) || !isLongitude(longitude)) return null;

  return { latitude: latitude, longitude: longitude };
}

function isLatitude(value) {
  return value >= -90 && value <= 90;
}

function isLongitude(value) {
  return value >= -180 && value <= 180;
}

function saveCoordinates(place, latitude, longitude) {
  let stored = loadObjectStore(coordinatesKey, 'place coordinates');
  stored[place.id] = { latitude: latitude, longitude: longitude };
  localStorage.setItem(coordinatesKey, JSON.stringify(stored));
}

function applyStoredCoordinates() {
  let stored = loadObjectStore(coordinatesKey, 'place coordinates');

  places.forEach(place => {
    let entry = stored[place.id];
    if (entry === null || typeof entry !== 'object') return;

    let latitude = Number(entry.latitude);
    let longitude = Number(entry.longitude);

    if (isFinite(latitude) && isFinite(longitude) && isLatitude(latitude) && isLongitude(longitude)) {
      place.latitude = latitude;
      place.longitude = longitude;
    }
  });
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

  let entry;

  try {
    entry = JSON.parse(cached);
  } catch (error) {
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

// Creates the container that keeps a place's label and canvas together, so the
// 40px column gap applies between places rather than between a label and its
// own chart.
//
// Both blocks always get a label row, even where the name is not shown. The
// precipitation chart sits on the same row as the temperature chart, and the
// columns are independent flex containers, so without that reserved space the
// right-hand canvas would start LABEL_HEIGHT higher than the left one and the
// two would not line up. The row has a fixed height so the match survives a
// slow webfont swap, where a measured height would briefly be wrong.
const LABEL_HEIGHT = '24px';

function createChartBlock(place, canvasId, showLabel) {
  let block = document.createElement('div');
  block.style.width = '100%';

  block.appendChild(createNameLabel(place, showLabel));

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

  if (!visible) {
    // Invisible spacer holding the row open, so both canvases start at the
    // same offset from the top of their column.
    label.style.visibility = 'hidden';
    label.setAttribute('aria-hidden', 'true');
    return label;
  }

  label.appendChild(createNameField(place));
  // One space of separation, matching how the two read on a single line.
  label.appendChild(document.createTextNode(' '));
  label.appendChild(createCoordinatesField(place));

  return label;
}

// Wires a span to be click- and keyboard-editable. Both fields behave the same
// way, so the activation handling lives here rather than being repeated.
function makeEditable(span, description, onActivate) {
  span.style.cursor = 'text';
  span.title = 'Click to edit the ' + description;
  span.tabIndex = 0;

  span.addEventListener('click', onActivate);
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
  span.textContent = formatCoordinates(place);
  span.style.color = COORDINATES_COLOR;
  span.style.fontSize = COORDINATES_FONT_SIZE;

  return makeEditable(span, 'coordinates', () => startEditingCoordinates(place, span));
}

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
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });

  // Escape cancels but still fires blur, so the guard above keeps the cancelled
  // edit from being committed.
  input.addEventListener('blur', commit);
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
      saveName(place, value);
      span.textContent = value;
    },
  });
}

function startEditingCoordinates(place, span) {
  startEditing(span, formatCoordinates(place), {
    editingColor: LABEL_COLOR,
    fontSize: COORDINATES_FONT_SIZE,
    inputWidth: '180px',
    onCancel: () => {
      span.textContent = formatCoordinates(place);
      span.style.color = COORDINATES_COLOR;
    },
    onCommit: value => {
      let parsed = parseCoordinates(value);

      if (parsed === null) {
        console.warn('Ignoring invalid coordinates "' + value + '"');
        span.textContent = formatCoordinates(place);
        span.style.color = COORDINATES_COLOR;
        return;
      }

      place.latitude = parsed.latitude;
      place.longitude = parsed.longitude;

      saveCoordinates(place, parsed.latitude, parsed.longitude);

      span.textContent = formatCoordinates(place);
      span.style.color = COORDINATES_COLOR;

      // The cached payload belongs to the old position, so drop it and reload
      // rather than showing stale weather for the new one.
      localStorage.removeItem(place.id);
      window.location.reload();
    },
  });
}

function plotData(place, daysData){
  let divContainer = document.getElementById('canvases');
  let chartBlock = createChartBlock(place, place.id, true);
  divContainer.appendChild(chartBlock.block);

  let chartData = daysData;

  new Chart(chartBlock.canvas, {
    type: 'line',
    data: {
      labels: chartData.map(element => element.day),
      datasets: [{
        label: 'Minimum',
        data: chartData.map(element => element.minimum),
        borderWidth: 1
      },{
        label: 'Maximum',
        data: chartData.map(element => element.maximum),
        borderWidth: 1
      },{
        label: 'Average',
        data: chartData.map(element => element.average),
        borderWidth: 1
      },{
        label: 'Median',
        data: chartData.map(element => element.median),
        borderWidth: 1
      },{
        label: 'Trend',
        data: chartData.map(element => element.trend),
        borderWidth: 1,
        pointRadius: 1,
      },]
    },
    options: chartScales(false)
  });
}

function plotPrecipitationData(place, daysData){
  let divContainer = document.getElementById('precipitationCanvases');
  let chartBlock = createChartBlock(place, place.id + '-precipitation', false);
  divContainer.appendChild(chartBlock.block);

  // One dataset per quantity, so Chart.js draws them side by side and a day
  // with no snow simply shows a single rain bar.
  new Chart(chartBlock.canvas, {
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

main();