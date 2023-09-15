class Place{
  constructor(name, latitude, longitude){
    this.name = name;
    this.latitude = latitude;
    this.longitude = longitude;
  }

  fetchUrl() {
    let url = 
      'https://api.open-meteo.com/v1/forecast?latitude='
      + this.latitude.toFixed(4)
      + '&longitude='
      + this.longitude.toFixed(4)
      + '&hourly=temperature_2m,precipitation&past_days=21&forecast_days=0';
      
    return url;
  }
}