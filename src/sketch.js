let data;
const dataKey = 'data';
const storingDateKey = 'storingDay';

let day;
let daysData = []
let places = ['krakow', 'madeira']

let temperatures;

function main() {
  data = JSON.parse(localStorage.getItem(dataKey));

  if (data === null || !isDataUpToDate()){
    fetchWeatherData();
  } else {
    console.log('Using existing data:');
    console.log(data);
    calculateValuesForDays();
    plotData();
  }
}

function isDataUpToDate(){
  let lastDataDate = new Date(data['hourly']['time'][data['hourly']['time'].length-1]);

  let yesterday = new Date(Date.now());
  yesterday.setDate(yesterday.getDate()-1);

  if (lastDataDate.getDate() != yesterday.getDate()) return false;
  
  if (lastDataDate.getMonth() != yesterday.getMonth()) return false;

  if (lastDataDate.getFullYear() != yesterday.getFullYear()) return false;
  
  return true;
}

function calculateValuesForDays() {
  for (let i = 0; i < data['hourly']['time'].length; i++) {
    const element = data['hourly']['time'][i];
    let elementDate = new Date(element);

    if (day == null) {
      newDay(i, elementDate);

    } else if (day == elementDate.getDate()) {
      temperatures.push(data['hourly']['temperature_2m'][i]);

    } else {
      if (temperatures.length == 0) continue;

      calculateThisDayValues(day);
      newDay(i, elementDate);
    }
  }
  calculateThisDayValues(day);
}

function calculateThisDayValues(day) {
  temperatures.sort(function(a, b){return a-b});

  let minimum = temperatures[0];
  let maximum = temperatures[temperatures.length - 1];
  let count = temperatures.length;
  let median;
  if (count % 2 == 0) {
    let middleA = temperatures[count / 2];
    let middleB = temperatures[(count / 2) - 1];
    median = 0.5 * (middleA + middleB);
  } else {
    median = temperatures[Math.floor(0.5 * count)];
  }

  let sum = 0;
  temperatures.forEach(t => sum += t);
  let average = sum / count;
  daysData.push(new DayData(day, minimum, maximum, average, median))
}

function newDay(i, elementDate) {
  temperatures = [data['hourly']['temperature_2m'][i]];
  day = elementDate.getDate();
}

function fetchWeatherData(){
  let url = 'https://api.open-meteo.com/v1/forecast?latitude=50.0614&longitude=19.9366&hourly=temperature_2m,precipitation&past_days=21&forecast_days=0';

  fetch(url)
  .then(response => {
    // Check if the response status is OK (status code 200)
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    return response.json();
  })
  .then(rawData => {
    data = rawData;
    storeData(data);
    calculateValuesForDays();
    plotData();
  })
  .catch(error => {
    console.error('Fetch error:', error);
  });
}

function storeData(newData){
  console.log('Storing new data:');
  console.log(newData);
  localStorage.setItem(dataKey, JSON.stringify(newData));
  localStorage.setItem(storingDateKey, Date.now());
}

function plotData(){
  let divContainer = document.getElementById('canvases');
  for (let i = 0; i < places.length; i++) {
    let canvas = document.createElement('canvas');
    canvas.id = places[i];
    divContainer.appendChild(canvas);

    const context = document.getElementById(places[i]);
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
}

main();
