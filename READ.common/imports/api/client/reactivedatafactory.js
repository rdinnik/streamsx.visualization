let Rx = require('rx/dist/rx.all');
let DOM = require('rx-dom').DOM;
let ajv = require('ajv');
let _  = require('underscore');

var exports = module.exports = {};
// define the various reactive classes here...
class Message {
  constructor(msg, isData) {
    this.isData = isData;
    if (isData) this.data = msg;
    else this.error = msg;
  }
}

class ReactiveData {
  // reactive must have _id, and must implement all the methods / properties referred to in reactivepipeline
  // We should for now get rid of the reset methods -- too complex... simply have new constructions each time for now
  constructor(_id, name) {
    this._id = _id;
    this.name = name;
    this.type = "abstract";
    this.stream = new Rx.ReplaySubject(1);
    this.injectError('Data Unavailable');
  }

  injectData(data) {
    this.stream.onNext(new Message(data, true));
  }

  injectError(errorObj) {
    this.stream.onNext(new Message(errorObj, false));
  }

  dispose() { // dispose my subscriptions
    throw new Error("dispose unsupported on ReactiveData of type 'abstract'");
  }

  getReactiveStream() {
    return this.stream;
  }

  resetReactiveStream(newStream) { // this makes sense only if there are no subscribers to the current stream
    let self = this;
    this.stream.doOnNext(msg => {
      self.stream = newStream;
      self.stream.onNext(msg);
    }).subscribe();
  }

}

class RawData extends ReactiveData {
  constructor(_id, name, data) {
    super(_id, name);
    this.type = "raw";
    if (data) this.injectData(data);
    else {
      this.injectError('Data Undefined');
    }
  }

  dispose() {} // we have no subscriptions to dispose
}

class IntervalData extends ReactiveData {
  constructor(_id, name, intervalMilliSec) { // interval in milli seconds
    super(_id, name);
    this.type = "interval";
    if (! ((intervalMilliSec) && (_.isNumber(intervalMilliSec)) && (intervalMilliSec >= 10))) {
      this.injectError('Invalid interval value: ' + interval);
    } else {
      let self = this;
      this.intervalSubscription = Rx.Observable.interval(intervalMilliSec).timeInterval().doOnNext(x => {
        self.injectData(x);
      }).subscribe(new Rx.ReplaySubject(0));
    }
  }

  dispose() {
    this.intervalSubscription.dispose();
  }
}

class WebsocketData extends ReactiveData {
  constructor(_id, name, url) {
    super(_id, name);
    this.type = "websocket";
    let self = this;
    let onInterval = false;

    // if socket closes due to a 'close' event (and not any other error), this follow up kicks in
    let closeFollowUp = function() {
      console.log('socket is about to close due to close error; initiating closeFollowUp');
      // // clean up existing subscriptions
      if (! onInterval) {
        onInterval = true;
        self.intervalSubscription = Rx.Observable.interval(3000 /* ms */)
        .take(40 /* try for a couple of minutes */)
        .doOnNext(() => {
          initSocket();
        }).subscribe(new Rx.ReplaySubject(0));
      }
    };

    // init the socket after disposing any existing subscriptions
    let initSocket = () => {
      if (self.socket) self.socket.onCompleted();
      if (self.subscription) self.subscription.dispose();

      self.socket = DOM.fromWebSocket(url);
      if (self.intervalSubscription) self.intervalSubscription.dispose();
      onInterval = false;

      self.subscription = self.socket
      .doOnNext(d => {
        self.injectData(JSON.parse(d.data))
      })
      .doOnError(e => {
        if (e.type === "close") {
          console.log('close error', e);
          closeFollowUp();
          return;
        }
        console.log('non-close error', e)
        // all other errors
        self.injectError('web socket error');
      })
      .subscribe(new Rx.ReplaySubject(0));
    };

    initSocket();
  }

  dispose() {
    if (this.intervalSubscription) this.intervalSubscription.dispose();
    if (this.subscription) this.subscription.dispose();
    if (this.socket) this.socket.onCompleted();
  }
}

const reactiveDataFactory = ['$http', function ($http) {
  // reactiveDataArray (array of parent reactives)
  // stateParams: is this stateful + initial state
  class TransformedData extends ReactiveData {
    constructor(_id, name, reactiveDataArray, transformFunction, state) {
      super(_id, name);
      this.type = "transformed";
      let self = this;

      let stateEnabled = state ? true: false;
      if (stateEnabled) this.state = state;

      let reactiveStreams = _.pluck(reactiveDataArray, 'stream');

      let injectSomething = function(latestArgs) {
        // one or more of the input streams contain error(s)
        if (_.some(latestArgs, (arg) => ! arg.isData)) {
          self.injectError('Transform function inputs contain error(s)');
        }
        else try {
          // inputs seem ok. We will try applying the transformFunction now.
          let data = undefined;
          let transformFunctionArgs = latestArgs.map((x) => JSON.parse(JSON.stringify(x.data)));
          if (stateEnabled) transformFunctionArgs.push(self.state);
          data = transformFunction(...transformFunctionArgs);
          if (! (_.isUndefined(data) || _.isNull(data))) self.injectData(data);
          else self.injectError('Transform function evaluation did not yield data');
        } catch (e) { // ran into errors during transformFunction application
          self.injectError('Error during transform function evaluation: ' + e.message);
        }
      }

      let somethingInjector = function(latestArgs) {
        injectSomething(latestArgs);
      }

      if (reactiveStreams.length > 0) {
        self.combiner = Rx.Observable.combineLatest(...reactiveStreams)
        .doOnNext(somethingInjector).subscribe(new Rx.ReplaySubject(0));
      } else {
        self.combiner = Rx.Observable.just([]).doOnNext(somethingInjector).subscribe(new Rx.ReplaySubject(0));
      }
    }

    dispose() {
      console.log('disposing transformed data');
      this.combiner.dispose();
    }
  }

  class ValidatedData extends TransformedData {
    static getValidator(jsonSchema) {
      let myjv = (new ajv({
        allErrors: true
      }));
      let validate = undefined;
      try {
        validate = myjv.compile(jsonSchema);
      }
      catch (e) {
        throw new Error('JSON Schema Compilation Error during ValidatedData construction');
      }

      return ((data) => {
        if (validate(data)) return data;
        if (validate.errors.length > 5) {
          throw new Error('Schema validation failure (limiting to 5 errors)- '.concat(myjv.errorsText(_.first(validate.errors, 5))));
        }
        else {
          throw new Error('Schema validation failure - '.concat(myjv.errorsText(validate.errors)))
        };
      });
    }

    constructor(_id, name, reactiveData, jsonSchema) {
      super(_id, name, [reactiveData], ValidatedData.getValidator(jsonSchema));
      this.type = 'jsonschema';
    }
  }

  // SimpleHTTPData and ExtendedHTTPData implementations below; other implementations above;
  class ExtendedHTTPData extends ReactiveData { // HTTP GET method
    constructor(_id, name, reactiveData, intervalMilliSec) { // interval in milli seconds // reactiveData provides the config
      super(_id, name);
      this.type = "extendedHTTP";
      let self = this;

      let injectSomething = (httpConfig) => {
        try {
          $http(httpConfig).then(response => {
            self.injectData(response.data);
          }, response => {
            self.injectError("Error during HTTP with status: " + response.status + " and statusText: " + response.statusText);
          })
        } catch (e) {
          self.injectError("Error during HTTP: " + e.message);
        }
      };

      if (! intervalMilliSec) {
        reactiveData.stream.doOnNext(x => {
          if (x.isData) injectSomething(x.data);
          else self.injectError("ExtendedHTTP parent dataset has error");
        }).subscribe();
      } else if (! ((_.isNumber(intervalMilliSec)) && (intervalMilliSec >= 10))) {
        self.injectError('Invalid interval value: ' + interval);
      } else {
        self.intervalGen = Rx.Observable.merge(Rx.Observable.just(0), Rx.Observable.interval(intervalMilliSec));
        self.intervalSubscription = Rx.Observable.combineLatest(reactiveData.stream, self.intervalGen, (x, y) => {
          return x;
        }).doOnNext(x => {
          if (x.isData) injectSomething(x.data);
          if (! x.isData) {
            self.injectError("ExtendedHTTP parent dataset has error");
          }
        }).subscribe(new Rx.ReplaySubject(0));
      }
    }

    dispose() {
      if (this.intervalSubscription) this.intervalSubscription.dispose();
    }
  }

  class SimpleHTTPData extends ExtendedHTTPData { // HTTP GET method
    constructor(_id, name, url, intervalMilliSec) { // interval in milli seconds
      super(_id, name, new RawData(_id + '-part', name + '-part', {
        method: 'GET',
        url: url
      }), intervalMilliSec);
      this.type = "simpleHTTP";
    }
  }

  let myFactory = {};
  myFactory.rawData = (_id, name, data) => new RawData(_id, name, data);
  myFactory.intervalData = (_id, name, intervalMilliSec) => new IntervalData(_id, name, intervalMilliSec);
  myFactory.transformedData = (_id, name, reactives, transformFunction, state) => new TransformedData(_id, name, reactives, transformFunction, state);
  myFactory.validatedData = (_id, name, reactiveData, schema) => new ValidatedData(_id, name, reactiveData, schema);
  myFactory.extendedHTTPData = (_id, name, reactiveData, intervalMilliSec) => new ExtendedHTTPData(_id, name, reactiveData, intervalMilliSec);
  myFactory.simpleHTTPData = (_id, name, url, intervalMilliSec) => new SimpleHTTPData(_id, name, url, intervalMilliSec);
  myFactory.websocketData = (_id, name, url) => new WebsocketData(_id, name, url);

  return myFactory;
}];

exports.reactiveDataFactory = reactiveDataFactory;
