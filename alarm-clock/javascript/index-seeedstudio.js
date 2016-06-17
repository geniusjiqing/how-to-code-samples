/*
* Copyright (c) 2015-2016 Intel Corporation.
*
* Permission is hereby granted, free of charge, to any person ("User") obtaining
* a copy of this software and associated documentation files (the
* "Software"), to deal in the Software without restriction, including
* without limitation the rights to use, copy, modify, merge, publish,
* distribute, sublicense, and/or sell copies of the Software, and to
* permit persons to whom the Software is furnished to do so, subject to
* the following conditions:
*
* The above copyright notice and this permission notice shall be
* included in all copies or substantial portions of the Software.
*
* User understands, acknowledges, and agrees that: (i) the Software is sample software;
* (ii) the Software is not designed or intended for use in any medical, life-saving
* or life-sustaining systems, transportation systems, nuclear systems, or for any
* other mission-critical application in which the failure of the system could lead to
* critical injury or death; (iii) the Software may not be fully tested and may contain
* bugs or errors; (iv) the Software is not intended or suitable for commercial release;
* (v) no regulatory approvals for the Software have been obtained, and therefore Software
* may not be certified for use in certain countries or environments.
*
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
* NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
* LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
* OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
* WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

"use strict";

var exports = module.exports = {};

// The program is using the Node.js built-in `fs` module
// to load the config.json and html file used to configure the alarm time
var fs = require("fs");

// The program is using the Node.js built-in `path` module to find
// the file path to the html file used to configure the alarm time
var path = require("path");

// Load configuration data from `config.json` file. Edit this file
// to change to correct values for your configuration
var config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"))
);

// The program is using the `superagent` module
// to make the remote calls to the Weather Underground API
var request = require("superagent");

// Initialize the hardware devices
var buzzer = new (require("jsupm_buzzer").Buzzer)(5),
    button = new (require("jsupm_grove").GroveButton)(4),
    rotary = new (require("jsupm_grove").GroveRotary)(0),
    screen = new (require("jsupm_i2clcd").Jhd1313m1)(6, 0x3E, 0x62);

// The program is using the `moment` module for easier time-based calculations,
// to determine when the alarm should be sounded.
var moment = require("moment");

var datastore = require("./datastore");
var mqtt = require("./mqtt");

// The program handles events generated by the various connected
// hardware devices using the Node.js built-in `events` module
var events = new (require("events").EventEmitter)();

// Colors used for the RGB LED
var colors = { red: [255, 0, 0], white: [255, 255, 255] },
    current,
    alarm;

// Sets the background color on the RGB LED
function color(string) {
  screen.setColor.apply(screen, colors[string] || colors.white);
}

// Displays a message on the RGB LED
function message(string, line) {
  // pad string to avoid display issues
  while (string.length < 16) { string += " "; }

  screen.setCursor(line || 0, 0);
  screen.write(string);
}

// Call the remote Weather Underground API to check the weather conditions
// change the LOCATION variable to set the location for which you want.
function getWeather() {
  if (!config.WEATHER_API_KEY) { return; }

  var url = "http://api.wunderground.com/api/";

  url += config.WEATHER_API_KEY;
  url += "/conditions/q/CA/" + config.LOCATION + ".json";

  function display(err, res) {
    if (err) { return console.error("unable to get weather data", res.text); }
    var conditions = res.body.current_observation.weather;
    console.log("forecast:", conditions);
    message(conditions, 1);
  }

  request.get(url).end(display);
}

// Display and then store record in the remote datastore and/or mqtt server
// of how long the alarm was ringing before it was turned off
function notify(duration) {

  var payload = { value: duration };
  datastore.log(config, payload);
  mqtt.log(config, payload);
}

// Called to start the alarm when the time has come to get up
function startAlarm() {
  var tick = true;
  console.log("Alarm duration (ms):" + duration);

  color("red");
  buzz();
  getWeather();

  var interval = setInterval(function() {
    color(tick ? "white" : "red");
    if (tick) { stopBuzzing(); } else { buzz(); }
    tick = !tick;
  }, 250);

  events.once("button-press", function() {
    clearInterval(interval);

    // notify how long alarm took to be silenced
    notify(moment().diff(alarm).toString());

    alarm = alarm.add(1, "day");

    color("white");
    stopBuzzing();
  });
}

// Adjust the brightness of the RGB LCD
function adjustBrightness(value) {
  var start = 0,
      end = 1020,
      val = Math.floor(((value - start) / end) * 255);

  if (val > 255) { val = 255; }
  if (val < 0) { val = 0; }

  screen.setColor(val, val, val);
}
// Sound an audible alarm when it is time to get up
function buzz() {
  buzzer.setVolume(0.5);
  buzzer.playSound(2600, 0);
}

// Turn off the audible alarm
exports.stopBuzzing = function() {
  buzzer.stopSound();
  buzzer.stopSound(); // if called only once, buzzer doesn't completely stop
}

// Loops every 100ms to check to fire a custom event with the
// latest value of the rotary dial, so we can check if has been moved
// Also checks to see if the button was pressed, so we can fire
// our custom button events if needed
exports.setupEvents = function() {
  var prev = { button: 0 };

  setInterval(function() {
    var pressed = button.value();

    events.emit("rotary", rotary.abs_value());

    if (pressed && !prev.button) { events.emit("button-press"); }
    if (!pressed && prev.button) { events.emit("button-release"); }

    prev.button = pressed;
  }, 100);
}

// Start the clock timer, then check every 50ms to see if is time to
// turn on the alarm
exports.startClock = function() {
  function after(a, b) { return a.isAfter(b, "second"); }
  function same(a, b) { return a.isSame(b, "second"); }

  setInterval(function() {
    var time = moment();

    // check if display needs to be updated
    if (after(time, current)) {
      message(time.format("h:mm:ss A"));
      if (same(current, alarm)) { startAlarm(); }
    }

    current = time;
  }, 50);
}
// Starts the built-in web server that serves up the web page
// used to set the alarm time
exports.server = function() {
  var app = require("express")();

  // Serve up the main web page used to configure the alarm time
  function index(res) {
    function serve(err, data) {
      if (err) { return console.error(err); }
      res.send(data);
    }
    fs.readFile(path.join(__dirname, "index.html"), {encoding: "utf-8"}, serve);
  }

  // Set new alarm time submitted by the web page using HTTP GET
  function get(req, res) {
    var params = req.query,
        time = moment();

    time.hour(+params.hour);
    time.minute(+params.minute);
    time.second(+params.second);

    if (time.isBefore(moment())) {
      time.add(1, "day");
    }

    alarm = time;

    index(res);
  }

  // Return the JSON data for the currently set alarm time
  function json(req, res) {
    if (!alarm) { return res.json({ hour: 0, minute: 0, second: 0 }); }

    res.json({
      hour: alarm.hour() || 0,
      minute: alarm.minute() || 0,
      second: alarm.second() || 0
    });
  }

  app.get("/", get);
  app.get("/alarm.json", json);

  app.listen(3000);
}
