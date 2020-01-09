import Ember from 'ember';
import { get, set, setProperties } from '@ember/object';
import { sendEvent } from '@ember/object/events';
import RSVP from 'rsvp';
import Service from '@ember/service';
import fetch from 'fetch';
import { A } from '@ember/array';
import { ApolloClient } from 'apollo-client';
import { InMemoryCache } from 'apollo-cache-inmemory';
import { createHttpLink } from 'apollo-link-http';
import { getOwner } from '@ember/application';
import { isArray } from '@ember/array';
import { isNone, isPresent } from '@ember/utils';
import { registerWaiter } from '@ember/test';
import deprecateComputed from 'ember-apollo-client/-private/deprecate-computed';
import { run } from '@ember/runloop';
import {
  apolloObservableKey,
  apolloUnsubscribeKey,
  QueryManager,
} from '../index';

class EmberApolloSubscription {
  lastEvent = null;
  _apolloClientSubscription = null;

  apolloUnsubscribe() {
    this._apolloClientSubscription.unsubscribe();
  }

  _onNewData(newData) {
    set(this, 'lastEvent', newData);
    sendEvent(this, 'event', [newData]);
  }
}

function extractNewData(resultKey, { data, loading }) {
  if (loading && isNone(data)) {
    // This happens when the cache has no data and the data is still loading
    // from the server. We don't want to resolve the promise with empty data
    // so we instead just bail out.
    //
    // See https://github.com/bgentry/ember-apollo-client/issues/45
    return null;
  }
  let keyedData = isNone(resultKey)
    ? { ...data }
    : data && get(data, resultKey);

  return keyedData || {};
}

function newDataFunc(observable, resultKey, resolve, unsubscribeFn = null) {
  let obj;

  return newData => {
    let dataToSend = extractNewData(resultKey, newData);

    if (dataToSend === null) {
      // see comment in extractNewData
      return;
    }

    if (isNone(obj)) {
      if (isArray(dataToSend)) {
        obj = A(dataToSend);
      } else {
        obj = { ...dataToSend };
      }

      if (!Object.prototype.hasOwnProperty.call(obj, apolloObservableKey)) {
        Object.defineProperty(obj, apolloObservableKey, {
          value: observable,
          writable: false,
        });
      }

      if (
        unsubscribeFn &&
        !Object.prototype.hasOwnProperty.call(obj, apolloUnsubscribeKey)
      ) {
        Object.defineProperty(obj, apolloUnsubscribeKey, {
          value: unsubscribeFn,
          writable: false,
        });
      }

      return resolve(obj);
    }

    isArray(obj) ? obj.setObjects(dataToSend) : setProperties(obj, dataToSend);
  };
}

export default class ApolloService extends Service {
  client = null;

  init() {
    super.init(...arguments);

    let options = this.clientOptions;
    if (typeof options === 'function') {
      options = this.clientOptions();
    } else {
      deprecateComputed('clientOptions');
    }

    this.client = new ApolloClient(options);

    if (Ember.testing) {
      this._registerWaiter();
    }
  }

  // options are configured in your environment.js.
  get options() {
    // config:environment not injected into tests, so try to handle that gracefully.
    let config = getOwner(this).resolveRegistration('config:environment');
    if (config && config.apollo) {
      return config.apollo;
    } else if (Ember.testing) {
      return {
        apiURL: 'http://testserver.example/v1/graph',
      };
    }
    throw new Error('no Apollo service options defined');
  }

  cache() {
    return new InMemoryCache();
  }

  link() {
    const { apiURL, requestCredentials } = this.options;
    const linkOptions = { uri: apiURL, fetch };

    if (isPresent(requestCredentials)) {
      linkOptions.credentials = requestCredentials;
    }
    return createHttpLink(linkOptions);
  }

  /**
   * This is the options hash that will be passed to the ApolloClient constructor.
   * You can override it if you wish to customize the ApolloClient.
   *
   * @method clientOptions
   * @return {!Object}
   * @public
   */
  clientOptions() {
    let { link, cache } = this;

    if (typeof link === 'function') {
      link = this.link();
    } else {
      deprecateComputed('link');
    }

    if (typeof cache === 'function') {
      cache = this.cache();
    } else {
      deprecateComputed('cache');
    }

    return { link, cache };
  }

  /**
   * Executes a mutation on the Apollo client. The resolved object will
   * never be updated and does not have to be unsubscribed.
   *
   * @method mutate
   * @param {!Object} opts The query options used in the Apollo Client mutate.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @public
   */
  mutate(opts, resultKey) {
    return this._waitFor(
      new RSVP.Promise((resolve, reject) => {
        this.client
          .mutate(opts)
          .then(result => {
            let dataToSend = isNone(resultKey)
              ? result.data
              : get(result.data, resultKey);
            return resolve(dataToSend);
          })
          .catch(error => {
            let errors;
            if (isPresent(error.networkError)) {
              error.networkError.code = 'network_error';
              errors = [error.networkError];
            } else if (isPresent(error.graphQLErrors)) {
              errors = error.graphQLErrors;
            }
            if (errors) {
              return reject({ errors });
            }
            throw error;
          });
      })
    );
  }

  /**
   * Executes a `watchQuery` on the Apollo client. If updated data for this
   * query is loaded into the store by another query, the resolved object will
   * be updated with the new data.
   *
   * When using this method, it is important to call `apolloUnsubscribe()` on
   * the resolved data when the route or component is torn down. That tells
   * Apollo to stop trying to send updated data to a non-existent listener.
   *
   * @method watchQuery
   * @param {!Object} opts The query options used in the Apollo Client watchQuery.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @public
   */
  watchQuery(opts, resultKey) {
    let observable = this.client.watchQuery(opts);
    let subscription;

    function unsubscribe() {
      subscription && subscription.unsubscribe();
    }

    return this._waitFor(
      new RSVP.Promise((resolve, reject) => {
        // TODO: add an error function here for handling errors
        subscription = observable.subscribe({
          next: newDataFunc(observable, resultKey, resolve, unsubscribe),
          error(e) {
            reject(e);
          },
        });
      })
    );
  }

  /**
   * Executes a `subscribe` on the Apollo client. If this subscription receives
   * data, the resolved object will be updated with the new data.
   *
   * When using this method, it is important to call `apolloUnsubscribe()` on
   * the resolved data when the route or component is torn down. That tells
   * Apollo to stop trying to send updated data to a non-existent listener.
   *
   * @method subscribe
   * @param {!Object} opts The query options used in the Apollo Client subscribe.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @public
   */
  subscribe(opts, resultKey = null) {
    const observable = this.client.subscribe(opts);

    const obj = new EmberApolloSubscription();

    return this._waitFor(
      new RSVP.Promise((resolve, reject) => {
        let subscription = observable.subscribe({
          next: newData => {
            let dataToSend = extractNewData(resultKey, newData);
            if (dataToSend === null) {
              // see comment in extractNewData
              return;
            }

            run(() => obj._onNewData(dataToSend));
          },
          error(e) {
            reject(e);
          },
        });

        obj._apolloClientSubscription = subscription;

        resolve(obj);
      })
    );
  }

  /**
   * Executes a single `query` on the Apollo client. The resolved object will
   * never be updated and does not have to be unsubscribed.
   *
   * @method query
   * @param {!Object} opts The query options used in the Apollo Client query.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @public
   */
  query(opts, resultKey) {
    return this._waitFor(
      new RSVP.Promise((resolve, reject) => {
        this.client
          .query(opts)
          .then(result => {
            let response = result.data;
            if (!isNone(resultKey)) {
              response = get(response, resultKey);
            }
            return resolve(response);
          })
          .catch(error => {
            return reject(error);
          });
      })
    );
  }

  /**
   * Executes a `watchQuery` on the Apollo client and tracks the resulting
   * subscription on the provided query manager.
   *
   * @method managedWatchQuery
   * @param {!Object} manager A QueryManager that should track this active watchQuery.
   * @param {!Object} opts The query options used in the Apollo Client watchQuery.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @private
   */
  managedWatchQuery(manager, opts, resultKey) {
    let observable = this.client.watchQuery(opts);
    let subscription;

    function unsubscribe() {
      subscription && subscription.unsubscribe();
    }

    return this._waitFor(
      new RSVP.Promise((resolve, reject) => {
        subscription = observable.subscribe({
          next: newDataFunc(observable, resultKey, resolve, unsubscribe),
          error(e) {
            reject(e);
          },
        });
        manager.trackSubscription(subscription);
      })
    );
  }

  /**
   * Executes a `subscribe` on the Apollo client and tracks the resulting
   * subscription on the provided query manager.
   *
   * @method managedSubscribe
   * @param {!Object} manager A QueryManager that should track this active subscribe.
   * @param {!Object} opts The query options used in the Apollo Client subscribe.
   * @param {String} resultKey The key that will be returned from the resulting response data. If null or undefined, the entire response data will be returned.
   * @return {!Promise}
   * @private
   */
  managedSubscribe(manager, opts, resultKey = null) {
    return this.subscribe(opts, resultKey).then(obj => {
      manager.trackSubscription(obj._apolloClientSubscription);

      return obj;
    });
  }

  createQueryManager() {
    return new QueryManager(this);
  }

  /**
   * Wraps a promise in test waiters.
   *
   * @param {!Promise} promise
   * @return {!Promise}
   * @private
   */
  _waitFor(promise) {
    this._incrementOngoing();
    return promise.finally(() => this._decrementOngoing());
  }

  // unresolved / ongoing requests, used for tests:
  _ongoing = 0;

  _incrementOngoing() {
    this._ongoing++;
  }

  _decrementOngoing() {
    this._ongoing--;
  }

  _shouldWait() {
    return this._ongoing === 0;
  }

  _registerWaiter() {
    this._waiter = () => {
      return this._shouldWait();
    };
    registerWaiter(this._waiter);
  }
}
