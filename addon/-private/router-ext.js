import Ember from 'ember';
import emberRequire from './ext-require';

const hasDefaultSerialize = emberRequire('ember-routing/system/route', 'hasDefaultSerialize');

const {
  Logger: {
    info
  },
  Router,
  RSVP,
  assert,
  get,
  getOwner
} = Ember;

Router.reopen({
  assetLoader: Ember.inject.service(),

  init() {
    this._super(...arguments);
    this._enginePromises = Object.create(null);
  },

  /**
   * When going to an Engine route, we check for QP meta in the BucketCache
   * instead of checking the Route (which may not exist yet). We populate
   * the BucketCache after loading the Route the first time.
   *
   * @override
   */
  _getQPMeta(handlerInfo) {
    let routeName = handlerInfo.name;
    if (this._engineInfoByRoute[routeName]) {
      return this._bucketCache.lookup('route-meta', routeName);
    }

    return this._super(...arguments);
  },

  /**
   * We override this to fetch assets when crossing into a lazy Engine for the
   * first time. For other cases we do the normal thing.
   *
   * @override
   */
  _getHandlerFunction() {
    let seen = Object.create(null);
    let owner = getOwner(this);

    return (name) => {
      let engineInfo = this._engineInfoByRoute[name];

      if (engineInfo) {
        let engineInstance = this._getEngineInstance(engineInfo);
        if (engineInstance) {
          return this._getHandlerForEngine(seen, name, engineInfo.localFullName, engineInstance);
        } else {
          return this._loadEngineInstance(engineInfo).then((instance) => {
            return this._getHandlerForEngine(seen, name, engineInfo.localFullName, instance);
          });
        }
      }

      // If we don't cross into an Engine, then the routeName and localRouteName
      // are the same.
      return this._internalGetHandler(seen, name, name, owner);
    };
  },

  /**
   * Gets the handler for a route from an Engine instance, proxies to the
   * _internalGetHandler method.
   *
   * @private
   * @method _getHandlerForEngine
   * @param {Object} seen
   * @param {String} routeName
   * @param {String} localRouteName
   * @param {Owner} routeOwner
   * @return {EngineInstance} engineInstance
   */
  _getHandlerForEngine(seen, routeName, localRouteName, engineInstance) {
    let handler = this._internalGetHandler(seen, routeName, localRouteName, engineInstance);

    if (!hasDefaultSerialize(handler)) {
      throw new Error('Defining a custom serialize method on an Engine route is not supported.');
    }

    return handler;
  },

  /**
   * This method is responsible for actually doing the lookup in getHandler.
   * It is separate so that it can be used from different code paths.
   *
   * @private
   * @method _internalGetHandler
   * @param {Object} seen
   * @param {String} routeName
   * @param {String} localRouteName
   * @param {Owner} routeOwner
   * @return {Route} handler
   */
  _internalGetHandler(seen, routeName, localRouteName, routeOwner) {
    const fullRouteName = 'route:' + localRouteName;
    let handler = routeOwner.lookup(fullRouteName);

    if (seen[routeName] && handler) {
      return handler;
    }

    seen[routeName] = true;

    if (!handler) {
      const DefaultRoute = routeOwner._lookupFactory('route:basic');

      routeOwner.register(fullRouteName, DefaultRoute.extend());
      handler = routeOwner.lookup(fullRouteName);

      if (get(this, 'namespace.LOG_ACTIVE_GENERATION')) {
        info(`generated -> ${fullRouteName}`, { fullName: fullRouteName });
      }
    }

    handler._setRouteName(localRouteName);
    handler._populateQPMeta();

    return handler;
  },

  /**
   * Checks the owner to see if it has a registration for an Engine. This is a
   * proxy to tell if an Engine's assets are loaded or not.
   *
   * @private
   * @method _engineIsLoaded
   * @param {String} name
   * @return {Boolean}
   */
  _engineIsLoaded(name) {
    let owner = getOwner(this);
    return owner.hasRegistration('engine:' + name);
  },

  /**
   * Registers an Engine that was recently loaded.
   *
   * @private
   * @method _registerEngine
   * @param {String} name
   * @return {Void}
   */
  _registerEngine(name) {
    let owner = getOwner(this);
    if (!owner.hasRegistration('engine:' + name)) {
      owner.register('engine:' + name, window.require(name + '/engine').default);
    }
  },

  /**
   * Gets the instance of an Engine with the specified name and instanceId.
   *
   * @private
   * @method _getEngineInstance
   * @param {Object} engineInfo
   * @param {String} engineInfo.name
   * @param {String} engineInfo.instanceId
   * @return {EngineInstance}
   */
  _getEngineInstance({ name, instanceId }) {
    let engineInstances = this._engineInstances;
    return engineInstances[name] && engineInstances[name][instanceId];
  },

  /**
   * Loads an instance of an Engine with the specified name and instanceId.
   * Returns a Promise for both Eager and Lazy Engines. This function loads the
   * assets for any Lazy Engines.
   *
   * @private
   * @method _loadEngineInstance
   * @param {Object} engineInfo
   * @param {String} engineInfo.name
   * @param {String} engineInfo.instanceId
   * @param {String} engineInfo.mountPoint
   * @return {Promise}
   */
  _loadEngineInstance({ name, instanceId, mountPoint }) {
    let enginePromises = this._enginePromises;

    if (!enginePromises[name]) {
      enginePromises[name] = Object.create(null);
    }

    let enginePromise = enginePromises[name][instanceId];

    // We already have a Promise for this engine instance
    if (enginePromise) {
      return enginePromise;
    }

    if (this._engineIsLoaded(name)) {
      // The Engine is loaded, but has no Promise
      enginePromise = RSVP.resolve();
    } else {
      // The Engine is not loaded and has no Promise
      enginePromise = this.get('assetLoader').loadBundle(name).then(() => this._registerEngine(name));
    }

    return enginePromises[name][instanceId] = enginePromise.then(() => {
      return this._constructEngineInstance({ name, instanceId, mountPoint });
    });
  },

  /**
   * Constructs an instance of an Engine based on an engineInfo object.
   * TODO: Figure out if this works with nested Engines.
   *
   * @private
   * @method _constructEngineInstance
   * @param {Object} engineInfo
   * @param {String} engineInfo.name
   * @param {String} engineInfo.instanceId
   * @param {String} engineInfo.mountPoint
   * @return {EngineInstance} engineInstance
   */
  _constructEngineInstance({ name, instanceId, mountPoint }) {
    let owner = getOwner(this);

    assert(
      'You attempted to mount the engine \'' + name + '\' in your router map, but the engine cannot be found.',
      owner.hasRegistration(`engine:${name}`)
    );

    let engineInstances = this._engineInstances;

    if (!engineInstances[name]) {
      engineInstances[name] = Object.create(null);
    }

    let engineInstance = owner.buildChildEngineInstance(name, {
      routable: true,
      mountPoint
    });

    engineInstance.boot();

    return engineInstances[name][instanceId] = engineInstance;
  }
});
