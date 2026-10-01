const dataKey = 'data';
const storingDateKey = 'storingDay';

// The API reports rainfall in mm but snowfall as snow DEPTH in cm. Snow density
// depends on the temperature, so this is only an estimate of the water
// equivalent, but it keeps both series on a single comparable axis.
const SNOW_DEPTH_CM_TO_MM_WATER = 1;

// Fields every cached payload must contain to be reusable. Caches written
// before rain/snowfall were requested are missing 'rain'/'snowfall' and must be
// treated as stale even when their date range still looks current.
const REQUIRED_HOURLY_FIELDS = ['time', 'temperature_2m', 'rain', 'snowfall'];

let places = []

async function main() {
  places.push(new Place('Cracow', 50.0614, 19.9366));
  places.push(new Place('Tenerife', 28.411515, -16.535813));

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

function hasRequiredFields(rawData) {
  if (rawData === null || typeof rawData !== 'object') return false;

  let hourly = rawData['hourly'];
  if (hourly === null || typeof hourly !== 'object') return false;

  return REQUIRED_HOURLY_FIELDS.every(field => hourly[field] !== undefined);
}

function readCachedData(place) {
  let cached = localStorage.getItem(place.name);
  if (cached === null) return null;

  let rawData;

  try {
    rawData = JSON.parse(cached);
  } catch (error) {
    // A truncated or non-JSON entry would otherwise abort the whole run.
    console.warn('Discarding unreadable cached data for ' + place.name);
    localStorage.removeItem(place.name);
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

  localStorage.setItem(place.name, JSON.stringify(rawData));
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
    scales: {
      y: {
        beginAtZero: beginAtZero,
        position: 'right',
        ticks: {
          color: '#aaaaaa',
        }
      },
      x: {
        ticks: {
          color: '#aaaaaa',
        }
      }
    }
  };
}

function plotData(place, daysData){
  let divContainer = document.getElementById('canvases');
  let canvas = document.createElement('canvas');
  canvas.id = place.name;
  divContainer.appendChild(canvas);

  const context = document.getElementById(place.name);
  let chartData = daysData;

  new Chart(context, {
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
  let canvas = document.createElement('canvas');
  canvas.id = place.name + '-precipitation';
  divContainer.appendChild(canvas);

  // One dataset per quantity, so Chart.js draws them side by side and a day
  // with no snow simply shows a single rain bar.
  new Chart(canvas, {
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
