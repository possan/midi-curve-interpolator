
var playermodule = require('./player');
var fs = require('fs');
var http = require('http');
var rest = require('restler');

//
// Set up MIDI
//

console.log('Setting up MIDI...');

var midi = require('midi');
var midioutput = new midi.output();
console.log('port count:', midioutput.getPortCount());
for (var k=0; k<midioutput.getPortCount(); k++)
	console.log('port #'+k+':', midioutput.getPortName(k));
midioutput.openPort(0);
console.log('Using first.');


function slerp(t, t0, t1, v0, v1) {
	t = Math.max(t0, Math.min(t1, t));
	var nt = (t - t0) / (t1 - t0);
	var ov = v0 + (v1 - v0) * nt;
	// ov = Math.max(v0, Math.min(v1, ov));
	return ov;
}

//
// curve class
//

var Curve = function() {
	this.first = undefined;
	this.last = undefined;
	this.points = [];
}

Curve.prototype.parse = function(json, key) {
	var _this = this;
	json.forEach(function(pt) {
		if (pt.key == key) {
			var ts = 0;
			if (typeof(pt.time) == 'number')
				ts = pt.time;
			else 
				ts = Date.parse(pt.time);
			if (ts < _this.first || _this.first === undefined) _this.first = ts;
			if (ts > _this.last || _this.last === undefined) _this.last = ts;
			_this.points.push({
				time: ts,
				displayTime: (new Date(ts)).toString(),
				value: pt.value
			});
		}
	});
	console.log('got datapoints', _this);
}

Curve.prototype.load = function(fn, key) {
	var _this = this;
	if (/http/.test(fn)) {
		rest.get(fn).on('complete', function(data) {
			_this.parse(data, key);
		});
	} else {
		var data = fs.readFileSync(fn);
		if (data) {
			var data2 = JSON.parse(data);
			if (data2) {
				this.parse(data2, key);
			}
		}
	}
}

Curve.prototype._findLeftKeyframe = function(t) {
	for(var i=this.points.length-1; i>=0; i--) {
		var pt = this.points[i];
		if (t >= pt.time) {
			return i;
		}
	}
	return -1;
}

Curve.prototype._getKeyframeTime = function(i) {
	if (i<0) i=0;
	if (i>this.points.length-1) i=this.points.length-1;
	if (i>=0)
		return this.points[i].time;
	return 0;
}

Curve.prototype._getKeyframeValue = function(i) {
	if (i<0) i=0;
	if (i>this.points.length-1) i=this.points.length-1;
	if (i>=0)
		return this.points[i].value;
	return 0;
}

Curve.prototype._getValue = function(t) {
	for(var i=this.points.length-1; i>=0; i--) {
		var pt = this.points[i];
		if (t >= pt.time) {
			return pt.value;
		}
	}
	return 0;
}

Curve.prototype.getInterpolatedValue = function(t) {
	var i1 = this._findLeftKeyframe(t);

	var t0 = this._getKeyframeTime(i1-1);
	var t1 = this._getKeyframeTime(i1);
	var t2 = this._getKeyframeTime(i1+1);
	var t3 = this._getKeyframeTime(i1+2);

	var v0 = this._getKeyframeValue(i1-1);
	var v1 = this._getKeyframeValue(i1);
	var v2 = this._getKeyframeValue(i1+1);
	var v3 = this._getKeyframeValue(i1+2);

	var nt = slerp( t, t1, t2, 0, 1 );
	var vv = slerp( t, t1, t2, v1, v2 );

	/*
	Hermite curve interpolation according to
	http://cubic.org/docs/hermite.htm     
	*/

	var h1 = (2 * nt * nt * nt) - (3 * nt * nt) + 1;
	var h2 = -(2 * nt * nt * nt) + (3 * nt * nt);
	var h3 = (nt * nt * nt) - (2 * nt * nt) + nt;
	var h4 = (nt * nt * nt) - (nt * nt);

	var pp =
		(h1 * v1) +
		(h2 * v2) + 
		(h3 * (v2 - v0)) + 
		(h4 * (v3 - v1));

	return pp;
}

//
// curve interpolator class
//

var CurveInterpolator = function(def) {
	this.channel = 0;
	this.control = 0;
	this.speed = 1.0;
	this.key = undefined;
	this.start = 0;
	this.end = 1.0;
	this.inputmin = 0.0;
	this.inputmax = 1.0;
	this.outputmin = 0;
	this.outputmax = 127;
	this.curve = new Curve();
	this.setup(def);
}

CurveInterpolator.prototype.setup = function(def) {
	this.settings = def;
	this.start = Date.parse(def.from);
	this.end = Date.parse(def.to);
	this.speed = def.speed;
	this.key = def.key;
	this.channel = def.channel;
	this.control = def.control;
	this.inputmin = def.inputrange[0];
	this.inputmax = def.inputrange[1];
	this.outputmin = def.outputrange[0];
	this.outputmax = def.outputrange[1];
	this.curve.load(def.dataset, this.key);
}

CurveInterpolator.prototype.getOutputValue = function(t) {
	var ts = 1000 * t * this.speed;
	var delta = this.end - this.start;
	ts %= delta;
	var real_ts = this.curve.first + ts;
	var v = this.curve.getInterpolatedValue(real_ts);
	var ov = slerp(v, this.inputmin, this.inputmax, this.outputmin, this.outputmax);
	return ov;
}

//
// load config
//

var json = JSON.parse(fs.readFileSync('config.json'));
var curves = json.curves.map(function(curvedef) {
	var cd = new CurveInterpolator(curvedef);
	return {
		last: -999.0,
		interpolator: cd
	};
});

//
// Set up sequence player
// 

var player = playermodule.Player( {
	bpm: 60,
	ppqn: 48,
	callback: function( arg ) {
		var step = arg.step / arg.ppqn;
		// console.log(arg.step / arg.ppqn);
		// seq.step( arg );
		curves.forEach(function(curve) {
			var v = curve.interpolator.getOutputValue(step);
			// console.log('step',step,'v',v);
			v = Math.round(v);
			if (v != curve.last) {
				// console.log('Curve for channel ' + curve.interpolator.channel+', control '+curve.interpolator.control+ ' changed to', v);
				midioutput.sendMessage([ 0xB0 + curve.interpolator.channel, curve.interpolator.control, v ]);
				curve.last = v;
			}
		});
	}
} );

console.log('starting playback.');
player.startTimer();
