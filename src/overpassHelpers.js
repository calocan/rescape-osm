/**
 * Created by Andy Likuski on 2017.04.03
 * Copyright (c) 2017 Andy Likuski
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import queryOverpass from 'query-overpass';
import {of, task} from 'folktale/concurrency/task';
import * as R from 'ramda';
import {
  reqStrPathThrowing,
  taskToResultTask,
  traverseReduceWhile,
} from 'rescape-ramda';
import os from 'os';
import 'regenerator-runtime';
import {loggers} from 'rescape-log';
import * as Result from 'folktale/result';

const log = loggers.get('rescapeDefault');

// When doing OSM queries with lat/lon points search for nodes withing this many meters of them
// The idea is that differences between Google, OSM, and manually marking of intersections should
// be within 10 meters. But this might have to be greater
export const AROUND_LAT_LON_TOLERANCE = 10;
export const AREA_MAGIC_NUMBER = 3600000000;
/**
 * Converts the osm id string to an area id string
 */
export const osmIdToAreaId = osmId => (parseInt(osmId) + AREA_MAGIC_NUMBER).toString();

// TODO make these accessible for external configuration
const servers = R.split(/\s*[,;\s]\s*/, process.env.OSM_SERVERS || '');

function* gen() {
  if (!R.length(servers)) {
    throw new Error("No servers configured. Define environmental variable OSM_SERVERS with comma-separated server urls with their api path. E.g. https://lz4.overpass-api.de/api/interpreter");
  }
  let serverIndex = -1;
  while (true) {
    serverIndex = R.modulo(serverIndex + 1, R.length(servers));
    yield servers[serverIndex];
  }
}

const genServer = gen();
const roundRobinOsmServers = () => {
  return genServer.next().value;
};


/**
 * Translates to OSM condition that must be true
 * @param {string} prop The feature property that must be true
 * @return {string} '["prop"]'
 */
export const osmAlways = prop => `[${prop}]`;

/**
 * Translates to OSM not equal condition
 * @param {string} prop The feature property that must not be euqal to the value
 * @param {object} value Value that toStrings appropriately
 * @return {string} '["prop" != "value"]'
 */
export const osmNotEqual = (prop, value) => osmCondition('!=', prop, value);

/**
 * Not equal statement using a tag function for if: statements
 * @param prop
 * @param value
 * @returns {string}
 */
export const osmNotEqualWithTag = (prop, value) => osmTCondition('!=', prop, value);

/**
 * Translates to OSM equals condition
 * @param {string} prop The feature property that must not be euqal to the value
 * @param {object} value Value that toStrings appropriately
 * @return {string} '["prop" = "value"]'
 */
export const osmEquals = (prop, value) => osmCondition('=', prop, value);

/**
 * Translates to OSM equals condition
 * @param {object} id The id to match
 * @return {string} '(id)'
 */
export const osmIdEquals = id => `(${id})`;

/**
 * Translates to OSM (in)equality condition
 * @param {string} operator Anything that osm supports '=', '!=', '>', '<', '>=', '<=', etc
 * @param {string} prop The feature property that must not be euqal to the value
 * @param {object} value Value that toStrings appropriately
 * @return {string} '["prop" operator "value"]'
 */
export const osmCondition = (operator, prop, value) => `["${prop}" ${operator} "${value}"]`;

/**
 * Conditional statement using the tag operator. Must be used inside an if: or similar
 * @param operator
 * @param prop
 * @param value
 * @returns {string}
 */
export const osmTCondition = (operator, prop, value) => `t["${prop}"] ${operator} "${value}"`;

/**
 * Constructs conditions for a certain OSM type, 'node', 'way', or 'relation'
 * @param {Array} conditions List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'
 * @param {String} type OSM type
 * @return {*} OSM Query statement for querying a certain type by conditions
 */
export const filtersForType = R.curry((conditions, type) => `${type}${R.join('', conditions)};`);

/**
 * Given an array of bounds lat, lon, lat, lon, return themn as a string for osm
 * @param {[Number]} bounds
 * @return {*}
 */
export const boundsAsString = bounds => {
  return R.pipe(
    list => R.concat(
      R.reverse(R.slice(0, 2)(list)),
      R.reverse(R.slice(2, 4)(list))),
    R.join(','),
    str => (`[bbox: ${str}]`)
  )(bounds);
};

/**
 * Uses an overpass if expression for boolean logic
 * @param expression
 * @returns {string}
 */
export const osmIf = expression => `(if: ${expression})`;

/**
 * Joins any number of expressions with &&s
 * @param expressions
 */
export const osmAnd = expressions => R.join(' && ', expressions);
/**
 * Joins any number of expressions with ||s
 * @param expressions
 */
export const osmOr = expressions => R.join(' || ', expressions);


// Filter to get roads and paths that aren't sidewalks or crossings
export const highwayWayFilters = R.join('', [
  osmAlways('highway'),
  // We're not currently interested in driveways, but might be in the future
  osmNotEqual('highway', 'driveway'),
  // Crosswalks
  osmNotEqual('footway', 'crossing'),
  // Sidewalks along a highway, these might be useful for some contexts
  osmNotEqual('footway', 'sidewalk'),
  osmNotEqual('service', 'parking_aisle'),
  osmNotEqual('service', 'driveway'),
  osmNotEqual('service', 'drive-through'),
  osmIf(
    osmOr(
      [
        osmNotEqualWithTag('highway', 'service'),
        osmNotEqualWithTag('access', 'private')
      ]
    )
  )
]);


/**
 * Street limitations on nodes.
 * Add more as they are discovered
 * For instance they can't be tagged as traffic signals!
 */
export const highwayNodeFilters = R.join('', [
  osmNotEqual('traffic_signals', 'signal')]
);

/**
 * Builds simple queries that just consist of filters on the given types
 */
export const buildFilterQuery = R.curry((settings, conditions, types) => {

  // For now we always apply the bounds as a bbox in settings
  const appliedSettings = `${R.join('', settings)}${boundsAsString(reqStrPathThrowing('bounds', conditions))};`;
  const filters = reqStrPathThrowing('filters', conditions);

  return `
  ${appliedSettings}
    (
  ${R.compose(
    R.join(os.EOL),
    R.map(type => filtersForType(filters, type))
  )(types)
    }
    );
    // print results
    out meta;/*fixed by auto repair*/
    >;
    out meta qt;/*fixed by auto repair*/
    `;
});


/**
 * Runs an OpenStreetMap task. Because OSM servers are picky about throttling,
 * this allows us to try all servers sequentially until one gives a result
 * @param {Object} config
 * @param {Number} [config.tries] Number of tries to make. Defaults to the number of server
 * @param {String} config.name The name taskFunc for logging purposes
 * @param {Object} config.testMockJsonToKey For mock testing only. JSON to identify the desired results
 * in __mocks__/query-overpass.js
 * @param taskFunc
 * @returns {Task<Result<Object>>} The response in a Result.Ok or errors in Result.Error
 */
export const osmResultTask = ({tries, name, testMockJsonToKey}, taskFunc) => {
  const attempts = tries || R.length(servers);
  return traverseReduceWhile(
    {
      // Fail the predicate to stop searching when we have a Result.Ok
      predicate: (previousResult, result) => R.complement(Result.Ok.hasInstance)(result),
      // Take the the last accumulation after the predicate fails
      accumulateAfterPredicateFail: true
    },

    // If we get a Result.Ok, just return it. The first Result.Ok we get is our final value
    // When we get Result.Errors, concat them for reporting
    (previousResult, result) => result.matchWith({
      Error: ({value}) => {
        log.warn(`Osm query failed on server ${value.server} with ${JSON.stringify(value.value)}`);
        return previousResult.mapError(R.append(value));
      },
      Ok: R.identity
    }),
    // Starting condition is failure
    of(Result.Error([])),
    // Create the task with each function. We'll only run as many as needed to get a resul
    R.times(attempt => {
      const server = roundRobinOsmServers();
      // Convert rejected tasks to Result.Error and resolved tasks to Result.Ok.
      // For errors wrap the server into the value so we can't report the erring server
      return taskToResultTask(
        //taskFunc({overpassUrl: server})
        task(({resolve}) => {
          log.info(`Starting OSM task ${name} attempt ${attempt + 1} of ${attempts} on server ${server}`);
          return resolve(server);
        }).chain(server => taskFunc({overpassUrl: server, testMockJsonToKey}))
      ).map(v => v.mapError(e => ({value: e, server})));
    }, attempts)
  );
};

/**
 * From the given query create a Task to run the query
 * @param {Object} options
 * @param {Number} options.sleepBetweenCalls: Optional value to slow down calls. This only matters when
 * multiple queries are running
 * @param {String} query The complete OSM query string
 * @return {Task} A task that calls query-overpass with the query and resolves to a query result
 */
export const taskQuery = (options, query) => {
  // Wrap overpass helper's execution and callback in a Task
  return task(resolver => {
    // Possibly delay each call to query_overpass to avoid request rate threshold
    // Since we are executing calls sequentially, this will pause sleepBetweenCalls before each call
    setTimeout(() => {
        log.debug(`Requesting OSM query:\n${query}`);
        queryOverpass(query, (error, data) => {
          if (!error) {
            resolver.resolve(data);
          } else {
            resolver.reject(error);
          }
        }, options);
      },
      options.sleepBetweenCalls || 0);
  });
};

/**
 * Run a provided query in osm. This assumes a complete query that doesn't need to be split into smaller calls.
 * Settings should be separate from the query in option.settings
 * @param {Object} options settings to pass to query-overpass
 * @param {String} options.overpassUrl server to query
 * @param {[String]} options.settings OSM query settings such as '[out:csv']`. Defaults to [`[out:json]`]. Don't
 * put a bounding box here. Instead put it in conditions.bounds.
 * @param {String} query A complete OSM query, minus the settings
 * @returns {Task} A Task to run the query
 */
export const fetchOsmRawTask = R.curry((options, query) => {
  // Default settings
  const settings = options.settings || [`[out:json]`];
  const appliedSettings = `${R.join('', settings)}${
    R.ifElse(
      R.prop('bounds'),
      // If bounds add them
      options => boundsAsString(reqStrPathThrowing('bounds', options)),
      // Otherwise assume we bound by area or something else non-global
      R.always('')
    )(options)
    };`;
  // Create a Task to run the query. Settings are already added to the query, so omit here
  return taskQuery(options, `${appliedSettings}${query}`);
});

/**
 * Creates a filter to only accept nodes around a given point that have at 2 least ways attached to them,
 * meaning they are intersections
 * @param {String} around: e.g. '(around: 10, 40.6660816, -73.8057879)'
 * @param {String} outputNodeName e.g. 'nodes1'
 * @param {boolean} leaveForAndIfBlocksOpen Default false. Leave the code blocks open so we can put another loop
 * for another point inside these loops.
 * @returns {string} The osm string
 * @private
 */
export const _filterForIntersectionNodesAroundPoint = (around, outputNodeName, leaveForAndIfBlocksOpen = false) => {
  const possibleNodes = `${outputNodeName}Possible`;
  const oneOfPossibleNodes = `oneOf${outputNodeName}Possible`;
  const waysOfOneOfPossibleNodes = `waysOfOneOf${outputNodeName}Possible`;
  return `node${around} -> .${possibleNodes};
foreach.${possibleNodes} ->.${oneOfPossibleNodes}
{
  way(bn.${oneOfPossibleNodes})${highwayWayFilters}->.${waysOfOneOfPossibleNodes};
  // If we have at least 2 ways, we have an intersection
  if (${waysOfOneOfPossibleNodes}.count(ways) >= 2)
  {
  .${oneOfPossibleNodes} -> .${outputNodeName};
  ${leaveForAndIfBlocksOpen ? '' : '} };'}`;
};

/**
 * Combines a location with the ways and nodes that came back from OSM queries, putting them in the location's
 * geojson property as a FeatureCollection
 * @param {Object} location A location object with intersections set matching the given ways and nodes
 * @param {[Object]} List of way features
 * @param {[Object]} nodes List of node features
 * @returns {f2|f1}
 */
export const locationAndOsmResultsToLocationWithGeojson = (location, {ways, nodes}) => R.set(
  R.lensProp('geojson'),
  {
    // Default geojson properties since we are combining multiple geojson results
    type: 'FeatureCollection',
    generator: 'overpass-turbo',
    copyright: 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.',
    features: [
      ...nodes,
      ...ways
    ]
  },
  location
);