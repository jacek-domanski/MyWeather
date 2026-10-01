const dataKey = 'data';
const storingDateKey = 'storingDay';
const namesKey = 'placeNames';

// The API reports rainfall in mm but snowfall as snow DEPTH in cm. Snow density
// depends on the temperature, so this is only an estimate of the water
// equivalent, but it keeps both series on a single comparable axis.
const SNOW_DEPTH_CM_TO_MM_WATER = 1;

// Fields every cached payload must contain to be reusable. Caches written
// before rain/snowfall were requested are missing 'rain'/'snowfall' and must be
// treated as stale even when their date range still looks current.
const REQUIRED_HOURLY_FIELDS = ['time', 'temperature_2m', 'rain', 'snowfall'];

// Shared by the axis ticks, the place names and the rename input so all text on
// the page reads as the same gray.
const LABEL_COLOR = '#aaaaaa';
const LABEL_FONT = 'Lato, sans-serif';

let places = []

async function main() {
  places.push(new Place('cracow', 'Cracow', 50.0614, 19.9366));
  places.push(new Place('tenerife', 'Tenerife', 28.411515, -16.535813));
  applyStoredNames();

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
  let stored = localStorage.getItem(namesKey);
  if (stored === null) return {};

  let parsed;

  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    console.warn('Discarding unreadable stored place names');
    localStorage.removeItem(namesKey);
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  return parsed;
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

function hasRequiredFields(rawData) {
  if (rawData === null || typeof rawData !== 'object') return false;

  let hourly = rawData['hourly'];
  if (hourly === null || typeof hourly !== 'object') return false;

  return REQUIRED_HOURLY_FIELDS.every(field => hourly[field] !== undefined);
}

function readCachedData(place) {
  let cached = localStorage.getItem(place.id);
  if (cached === null) return null;

  let rawData;

  try {
    rawData = JSON.parse(cached);
  } catch (error) {
    // A truncated or non-JSON entry would otherwise abort the whole run.
    console.warn('Discarding unreadable cached data for ' + place.name);
    localStorage.removeItem(place.id);
    return null;
  }

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

  localStorage.setItem(place.id, JSON.stringify(rawData));
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

  label.textContent = place.name;
  label.style.cursor = 'text';
  label.title = 'Click to rename this location';
  label.tabIndex = 0;

  label.addEventListener('click', () => startEditingName(place, label));
  label.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      startEditingName(place, label);
    }
  });

  return label;
}

function startEditingName(place, label) {
  // Guard against a second click stacking a second input inside the same label.
  if (label.querySelector('input') !== null) return;

  let input = document.createElement('input');
  input.type = 'text';
  input.value = place.name;
  input.style.color = LABEL_COLOR;
  input.style.backgroundColor = 'transparent';
  input.style.border = '1px solid #555555';
  input.style.fontFamily = LABEL_FONT;
  input.style.fontSize = '18px';
  input.style.width = '300px';

  label.textContent = '';
  label.appendChild(input);
  input.focus();
  input.select();

  let finished = false;

  function commit() {
    if (finished) return;
    finished = true;

    let value = input.value.trim();

    // An empty name is treated as "no change" so a place is never left blank.
    if (value === '' || value === place.name) {
      label.textContent = place.name;
      return;
    }

    place.name = value;
    saveName(place, value);
  }

  function cancel() {
    if (finished) return;
    finished = true;
    label.textContent = place.name;
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

  // Escape cancels but still fires blur, so the guard above keeps the original
  // name from being overwritten by the cancelled edit.
  input.addEventListener('blur', commit);
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