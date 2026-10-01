class DayData{
  constructor(day, minimum, maximum, average, median){
    this.day = day;
    this.maximum = maximum;
    this.minimum = minimum;
    this.average = average;
    this.median = median;
    this.rain = 0;
    this.snow = 0;
  }

  setTrend(trend) {
    this.trend = trend;
  }

  setPrecipitation(rain, snow) {
    this.rain = rain;
    this.snow = snow;
  }
}
