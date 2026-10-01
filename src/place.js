class Place{
  constructor(id, name, latitude, longitude, pending = false){
    // 'id' is stable and never shown to the user; 'name' is editable and is
    // what gets displayed. Storage keys must use the id, otherwise renaming a
    // place would orphan its cached data and duplicate names would collide.
    this.id = id;
    this.name = name;
    this.latitude = latitude;
    this.longitude = longitude;
    // Set for a freshly added place with no location chosen yet. Such a place is
    // not fetched until coordinates are entered.
    this.pending = pending;
  }

  fetchUrl() {
    let url = 
      'https://api.open-meteo.com/v1/forecast?latitude='
      + this.latitude.toFixed(4)
      + '&longitude='
      + this.longitude.toFixed(4)
      + '&hourly=temperature_2m,precipitation,rain,snowfall&past_days=21&forecast_days=0';
      
    return url;
  }
}