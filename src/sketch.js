const dataKey = 'data';
const storingDateKey = 'storingDay';

let places = []

async function main() {
  places.push(new Place('Cracow', 50.0614, 19.9366));
  places.push(new Place('Tenerife', 28.411515, -16.535813));

  for (let i = 0; i < places.length; i++) {
    let place = places[i];
    let rawData = JSON.parse(localStorage.getItem(place.name));

    if (rawData === null || !isDataUpToDate(rawData)){
      rawData = await fetchWeatherData(place);
      console.log('Downloading new data for ' + place.name);
    } else {
      console.log('Using existing data for ' + place.name);
    }
    console.log(rawData);
    let daysData = calculateValuesForDays(rawData);
    plotData(place, daysData);
  }
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

  let rawData = await fetch(url)
  .then(response => {
    // Check if the response status is OK (status code 200)
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    return response.json();
  })
  .catch(error => {
    console.error('Fetch error:', error);
  });
  storeData(rawData, place);
  return rawData;
}

function storeData(rawData, place){
  localStorage.setItem(place.name, JSON.stringify(rawData));
  localStorage.setItem(storingDateKey, Date.now());
}

function calculateValuesForDays(rawData) {
  let day = null;
  let daysTemperatures = [];
  let daysData = [];

  for (let i = 0; i < rawData['hourly']['time'].length; i++) {
    const element = rawData['hourly']['time'][i];
    let elementDate = new Date(element);

    if (day == null) {
      [day, daysTemperatures] = newDay(i, elementDate, rawData);

    } else if (day == elementDate.getDate()) {
      daysTemperatures.push(rawData['hourly']['temperature_2m'][i]);

    } else {
      if (daysTemperatures.length == 0) continue;

      calculateThisDayValues(day, daysTemperatures, daysData);
      [day, daysTemperatures] = newDay(i, elementDate, rawData);
    }
  }
  calculateThisDayValues(day, daysTemperatures, daysData);
  calculateTrend(daysData);
  return daysData;
}

function newDay(i, elementDate, rawData) {
  let daysTemperatures = [rawData['hourly']['temperature_2m'][i]];
  return [elementDate.getDate(), daysTemperatures];
}

function calculateThisDayValues(day, daysTemperatures, daysData) {
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
  daysData.push(new DayData(day, minimum, maximum, average, median))
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
    options: {
      scales: {
        y: {
          beginAtZero: false,
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
    }
  });
}

main();
