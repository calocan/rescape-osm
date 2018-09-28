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
import {task, of, waitAll} from 'folktale/concurrency/task';
import * as R from 'ramda';
import {
  findOneThrowing,
  fromPairsMap,
  mapObjToValues, mergeAllWithKey, removeDuplicateObjectsByProp, reqPathThrowing,
  reqStrPathThrowing
} from 'rescape-ramda';
import os from 'os';
import squareGrid from '@turf/square-grid';
import bbox from '@turf/bbox';
import {concatFeatures} from 'rescape-helpers';
import {fullStreetNamesOfLocationTask} from './googleLocation';
import {nominatimTask} from './searchIO';

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
 * Translates to OSM equals condition
 * @param {string} prop The feature property that must not be euqal to the value
 * @param {object} value Value that toStrings appropriately
 * @return {string} '["prop" = "value"]'
 */
export const osmEquals = (prop, value) => osmCondition('=', prop, value);

/**
 * Translates to OSM (in)equality condition
 * @param {string} operator Anything that osm supports '=', '!=', '>', '<', '>=', '<=', etc
 * @param {string} prop The feature property that must not be euqal to the value
 * @param {object} value Value that toStrings appropriately
 * @return {string} '["prop" operator "value"]'
 */
export const osmCondition = (operator, prop, value) => `["${prop}" ${operator} "${value}"]`;


/**
 * Constructs conditions for a certain OSM type, 'node', 'way', or 'relation'
 * @param {Array} conditions List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'
 * @param {String} type OSM type
 * @return {*} OSM Query statement for querying a certain type by conditions
 */
const filtersForType = R.curry((conditions, type) => `${type}${R.join('', conditions)};`);

/**
 * Given an array of bounds lat, lon, lat, lon, return themn as a string for osm
 * @param {[Number]} bounds
 * @return {*}
 */
const boundsAsString = bounds => {
  return R.pipe(
    list => R.concat(
      R.reverse(R.slice(0, 2)(list)),
      R.reverse(R.slice(2, 4)(list))),
    R.join(','),
    str => (`[bbox: ${str}`)
  )(bounds);
};


/**
 * Builds simple queries that just consist of filters on the given types
 */
const buildFilterQuery = R.curry((settings, conditions, types) => {

  // For now we always apply the bounds as a bbox in settings
  const appliedSettings = `${R.join('', settings)}${boundsAsString(reqStrPathThrowing('bounds', settings))};`;
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
 * From the given query create a Task to run the query
 * @param {Object} options
 * @param {Number} options.sleepBetweenCalls: Optional value to slow down calls. This only matters when
 * multiple queries are running
 * @param {String} query The complete OSM query string
 * @return {Task} A task that calls query-overpass with the query
 */
const taskQuery = (options, query) => {
  // Wrap overpass helper's execution and callback in a Task
  return task(resolver => {
    // Possibly delay each call to query_overpass to avoid request rate threshold
    // Since we are executing calls sequentially, this will pause sleepBetweenCalls before each call
    setTimeout(() =>
        queryOverpass(query, (error, data) => {
          if (!error) {
            resolver.resolve(data);
          } else {
            resolver.reject(error);
          }
        }, options),
      options.sleepBetweenCalls || 0);
  });
};

/**
 * fetches transit data from OpenStreetMap using the Overpass API.
 * @param {Object} options settings to pass to query-overpass, plus the following options:
 * @param {[String]} options.settings OSM query settings such as '[out:csv']`. Defaults to [`[out:json]`]. Don't
 * put a bounding box here. Instead put it in conditions.bounds.
 * @param {Object} options.testBounds Used only for testing
 * @param {Object} options.cellSize If specified delegates to fetchCelled
 * @param {Array} conditions List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'.
 * @param {Array} conditions.filters List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'.
 * The conditions apply to all types given
 * @param {[Number]} conditions.bounds Required [lat_min, lon_min, lat_max, lon_max] to limit all conditions
 * @param {[String]} types List of OSM type sto query by e.g. ['way', 'node', relation']
 * @returns {Object} Task to fetchOsm the data
 */
export const fetchOsm = R.curry((options, conditions, types) => {
  // Default settings
  const settings = options.settings || [`[out:json]`];
  const defaultOptions = R.merge(options, {settings});

  if (options.cellSize) {
    return fetchOsmCelled(defaultOptions, conditions, types);
  }
  // Build the query
  const query = buildFilterQuery(defaultOptions.settings, conditions, types);
  // Create a Task to run the query. Settings are already added to the query, so omit here
  return taskQuery(R.omit(['settings'], options), query);
});

/**
 * Run a provided query in osm. This assumes a complete query that doesn't need to be split into smaller calls.
 * Settings should be separate from the query in option.settings
 * @param {Object} options settings to pass to query-overpass
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
 * fetches transit data in squares sequentially from OpenStreetMap using the Overpass API.
 * (concurrent calls were triggering API throttle limits)
 * @param {Number} cellSize Splits query-overpass into separate requests, by splitting
 * the bounding box by the number of kilometers specified here. Example, if 200 is specified,
 * 200 by 200km bounding boxes will be created and sent to query-overpass. Any remainder will
 * be queried separately. The results from all queries are merged by feature id so that no
 * duplicates are returned.
 * @param {[Number]} bounds [lat_min, lon_min, lat_max, lon_max]
 * @param {Number} options.sleepBetweenCalls Pause this many milliseconds between calls to avoid the request rate limit
 * @param {Object} options.testBounds Used only for testing
 * @param {Array} conditions List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'.
 * @param {Array} conditions.filters List of query conditions, each in the form '["prop"]' or '["prop" operator "value"]'.
 * The conditions apply to all types given
 * @param {[Number]} conditions.bounds Required [lat_min, lon_min, lat_max, lon_max] to limit all conditions
 * @param {[String]} types List of OSM type sto query by e.g. ['way', 'node', relation']
 * @returns {Task} Chained Tasks to fetchOsm the data
 */
const fetchOsmCelled = ({cellSize, ...options}, conditions, types) => {
  const squareGridOptions = {units: 'kilometers'};
  // Use turf's squareGrid function to break up the bbox by cellSize squares
  const squareBoundaries = R.map(
    polygon => bbox(polygon),
    squareGrid(reqStrPathThrowing('bounds', conditions), cellSize, squareGridOptions).features);

  // Create a fetchOsm Task for reach square boundary
  // fetchTasks :: Array (Task Object)
  const fetchTasks = R.map(
    boundary => fetchOsm(
      options,
      R.merge(conditions, {boundary}),
      types
    ),
    squareBoundaries);

  // chainedTasks :: Array (Task Object) -> Task.chain(Task).chain(Task)...
  // We want each request to overpass to run after the previous is finished
  // so as to not exceed the permitted request rate. Chain the tasks and reduce
  // them using map to combine all previous Task results.
  const chainedTasks = R.reduce(
    (prevChainedTasks, fetchTask) => prevChainedTasks.chain(results =>
      fetchTask.map(result =>
        R.concat(results.length ? results : [results], [result])
      )
    ),
    R.head(fetchTasks),
    R.tail(fetchTasks));


  // This combines the results of all the fetchOsm calls and removes duplicate results
  // sequenced :: Task (Array Object)
  // const sequenced = R.sequence(Task.of, fetchTasks);
  return chainedTasks.map(results =>
    R.compose(
      // Lastly remove features with the same id
      R.over(
        R.lens(R.prop('features'), R.assoc('features')),
        removeDuplicateObjectsByProp('id')
      ),
      // First combine the results into one obj with concatinated features
      mergeAllWithKey(concatFeatures)
    )(results)
  );
};

/**
 * Constructs an OSM query for the given location. Queries are limited to the city of the location
 * and return the ways and nodes related two the intersections. These are more than are actually
 * needed because some refer to ways that are outside the block between the intersections but connected to them.
 * Thus they need to be cleaned up after. The OSM query language is too weak to do it here.
 * Unfortunately the OSM API messed up results if we query for both node and ways together. So I've added the
 * mandatory type argument of 'way' or 'node'. You must query for each separately
 * @param {String} type Either 'way' or 'node'
 * @param {String} country Required country for area resolution
 * @param {String} state Optional depending on the country
 * @param {String} city Required string for area resolution
 * @param {[[String]]} intersections Required two pairs of intersection names that are full street names, i.e.
 * Avenue not Ave
 * @return {string}
 */
const constructLocationQuery = ({type}, {country, state, city, intersections, osmId}) => {

  // The Overpass Area Id is based on the osm id plus this magic nubmer
  const areaId = parseInt(osmId) + 3600000000;
  // Fix all street endings. OSM needs full names: Avenue not Ave, Lane not Ln
  const streetCount = R.reduce(
    (accum, street) => R.over(
      R.lensProp(street),
      value => (value || 0) + 1,
      accum
    ),
    {},
    R.flatten(intersections)
  );
  if (!R.find(R.equals(2), R.values(streetCount))) {
    throw `No common block in intersections: ${JSON.stringify(intersections)}`;
  }
  // Sort each intersection, putting the common block first
  const modifiedIntersections = R.map(
    intersection => R.reverse(R.sortBy(street => R.prop(street, streetCount), intersection)),
    intersections
  );
  // List the 3 blocks: common block and then other two blocks
  const orderedBlocks = [R.head(R.head(modifiedIntersections)), ...R.map(R.last, modifiedIntersections)];

  const query = `
    ${
    R.join('\n',
      R.addIndex(R.map)(
        (block, i) => `way(area:${areaId})[highway][name="${block}"][footway!="crossing"]->.w${i + 1};`,
        orderedBlocks
      )
    )
    }
// Get the two intersection nodes 
// node contained in w1 and w2
(node(w.w1)(w.w2);
// node contained in w1 and w3
 node(w.w1)(w.w3);
)->.allnodes;
// Get all main ways containing one or both nodes
way.w1[highway](bn.allnodes)->.ways; 
// Either return nodes or ways. Can't do both because the API messes up the geojson
(${ R.cond([
    [R.equals('way'), R.always('.ways')],
    [R.equals('node'), R.always('.allnodes')],
    [R.T, () => {
      throw Error('type argument must specified and be "way" or "node"');
    }]
  ])(type) };)->.outputSet;
.outputSet out geom;
`;
  return query;
};

/**
 * Makes a string from a point array for hashing
 * @param {[Number}] point Two element array
 */
const hashPoint = point => {
  return R.join(':', point);
};

/***
 * Reduces a LineString feature by it's head and last point
 * @param {Object} result The accumulating result. This might already be filled with other features.
 * The return value adds this features head and last points to the result. The form of this is
 * {
 *  coordinate_hash1: {head: [features], last: [features]},
 *  coordinate_hash2: {head: [features], last: [features]},
 *  ...
 * }
 * @param {Object} feature geojson LineString feature
 * @returns {Object} Accumulation of result plus the two feature points has by ['head'|'last'] and then coordinate hash
 */
const _reduceFeaturesByHeadAndLast = (result, feature) => {
  return R.reduce(
    (res, headLast) => {
      return R.over(
        // hash the head or tail point
        R.lensProp(
          hashPoint(
            R[headLast](feature.geometry.coordinates)
          )
        ),
        // Find the hash in res (it might be undefined)
        resultsForPoint => {
          // Operate on it or create a new dict to operate on
          return R.over(
            // Find the 'head' or 'tail' property
            R.lensProp(headLast),
            // Operate on it or create a new array, adding feature
            resultsForPointEnd => R.concat(resultsForPointEnd || [], [feature]),
            resultsForPoint || {}
          );
        },
        res
      );
    },
    result,
    ['head', 'last']
  );
};

/**
 * Given two node points and criteria for matching, returns true if the given LineString feature matches
 * @param {[String]} Two hash node point coordinates
 * @param {Object} lineStringFeature a Geojson feature that is a LineString type
 * @returns {Object} With keys 'head' and 'last' and valued true|false depending on if it matched.
 * I can match 0, 1, or both
 */
const _lineStringFeatureEndNodeMatches = R.curry((nodePointHashes, lineStringFeature) => {
  const isContainedInNodePoints = R.flip(R.contains)(nodePointHashes);
  const headLastValues = ['head', 'last'];
  // See if the two node points match the feature end-points
  // This creates an array for whether it matches head and last respectively [true|false, true|false]
  return R.compose(
    R.fromPairs,
    R.map(
      headLast => R.compose(
        // return key 'head' or 'last' with value of whether it matched
        matched => [headLast, matched],
        // Does it match one of the node points?
        isContainedInNodePoints,
        // Hash the head or last point of the feature
        points => hashPoint(R[headLast](points))
      )(lineStringFeature.geometry.coordinates)
    )
  )(headLastValues);
});

/***
 * Returns an update to the given nodeMatches by checking what the given feature matches
 * @param {[Object]} nodeFeatures The two node geojson objects representing the two street intersections
 * to be merged with the given nodeMatches
 * @param {Object} nodeMatches {head: true|false, tail: true|false}
 * @param {Object} feature Object to test
 * @returns {Object} New verion of nodeMatches based on testing feature. Note that nodeMatches['tail']
 * is not allowed to be set true until nodeMatches['head'] returns true
 * @private
 */
const _updateNodeMatches = nodeFeatures => {
  const nodePointHashes = R.map(node => hashPoint(node.geometry.coordinates), nodeFeatures);

  return (nodeMatches, feature) => {
    const newNodeMaches = _lineStringFeatureEndNodeMatches(nodePointHashes, feature);
    return R.mergeWith(
      // Merge with previous result and then and with nodeMatches['head']. This means nodeMatches['last'] can't
      // be true until nodeMatches['head'] is
      (l, r) => R.compose(
        R.and(R.any(R.prop('head'), [nodeMatches, newNodeMaches])),
        R.or
      )(l, r),
      nodeMatches,
      newNodeMaches
    );
  };
};

/**
 * Returns Features linked in order
 * @param {Object} lookup. Structure created in _reduceFeaturesByHeadAndLast
 * @param {[Object]} nodeFeatures. The two nodeFeatures. These serve as the boundaries of the features
 * @returns {[Object]} The ordered features from head to last. Any features that are outside of the nodes
 * are left out
 */
const _linkedFeatures = (lookup, nodeFeatures) => {
  // Now start with the head feature and link our way to the end feature
  const [headPointToFeature, lastPointToFeature] = R.map(
    headLast => R.compose(
      // Convert 1 item dict to 1 item dict valued by the single feature
      R.map(value => R.head(R.prop(headLast, value))),
      // Filter by objects having only a 'head' or 'last' key, not both
      R.filter(obj => R.both(
        R.compose(R.equals(1), R.length, R.keys),
        R.prop(headLast)
        )(obj)
      )
    )(lookup),
    ['head', 'last']
  );
  const lastFeature = R.head(R.values(lastPointToFeature));


  // Get the two node points
  const _updateNodeMatchesPartial = _updateNodeMatches(nodeFeatures);

  // Starting at the head, find the point who's last item contains the previous feature
  let resolvedPointLookups = headPointToFeature;
  let previousFeature = R.head(R.values(headPointToFeature));
  // Tracks when we have matched at the starting point and ending point of a LineString Feature.
  // We can't allow Features to yield until one first matches at its head (first) point
  // As soon as one matches at its end point we are done matching features, and any remaining are disgarded
  let nodeMatches = {head: false, last: false};

  function* linker(lookup) {
    // Yield the head feature if its head (first) point matches a nodeFeature
    // Having only its last point match means its not between the two nodes.
    // Normally this first way will not match because the first way returned by OSM will touch a node at its last point
    // However if its the start/end of the street then the first way should match at its first point
    nodeMatches = _updateNodeMatchesPartial(nodeMatches, previousFeature);

    if (R.prop('head', nodeMatches)) {
      // Mark that we've intersected one of the nodes
      yield previousFeature;
    }

    // If the previousFeature was our last feature or nodeMatches['last'] has occurred, we are done
    // nodeMatches['last'] is true when the last point of a LineString feature has matched an end node
    // This should always be true by the time we process the last feature, if not earlier
    // If either clause is true quit
    while (R.not(R.or(
      R.prop('last', nodeMatches),
      R.equals(previousFeature, lastFeature)
    ))) {
      // Find the pointLookup whose point is the last point for the currentFeature
      const nextPointLookup = findOneThrowing(
        pointLookupValue => R.pathEq(['last', 0], previousFeature)(pointLookupValue),
        R.omit(R.keys(resolvedPointLookups), lookup)
      );
      // Make the single item object keyed by next point and valued by feature whose head is the next point
      const nextPointToFeature = R.map(value => R.head(R.prop('head', value)), nextPointLookup);
      resolvedPointLookups = R.merge(resolvedPointLookups, nextPointToFeature);
      // Store it for the next round
      previousFeature = R.head(R.values(nextPointToFeature));
      // Yield the feature if this or previous feature matched a node on its head (first) point
      nodeMatches = _updateNodeMatchesPartial(nodeMatches, previousFeature);
      if (R.prop('head', nodeMatches)) {
        yield previousFeature;
      }
    }
  }

  return [...linker(lookup)];
};

/***
 * Sorts the features by connecting them at their start/ends
 */
const sortFeatures = (wayFeatures, nodeFeatures) => {
  // Build a lookup of start and end points
  // This results in {
  //  end_coordinate_hash: {head: [feature]}
  //  coordinate_hash: {head: [feature], tail: [feature] }
  //  end_coordinate_hash: {tail: [feature]}
  //}
  // Note that two hashes have only one feature. One with one at the head and one with one at the tail
  // The other have two features. So this gives us a good idea of how the features are chained together
  const lookup = R.reduce(
    (result, feature) => {
      return _reduceFeaturesByHeadAndLast(result, feature);
    },
    {},
    wayFeatures
  );
  // Use the linker to link the features together, dropping those that aren't between the two nodes
  return _linkedFeatures(lookup, nodeFeatures);

};

export const queryLocation = location => {
  // This long chain of Task reads bottom to top. Only the functions marked Task are actually async calls.
  // Everything else is wrapped in a Task to match the expected type
  return R.composeK(
    location => locationToQueryResults(location),
    // OSM needs full street names (Avenue not Ave), so use Google to resolve them
    location => fullStreetNamesOfLocationTask(location).map(
      // Replace the intersections with the fully qualified names
      intersections => R.merge(location, {intersections})
    )
  )(location);
};

/**
 * Resolve the location and then query for the block in overpass.
 * Overpass will give us too much data back, so we have to clean it up in sortFeatures.
 * This process will first use nominatimTask to query nomatim.openstreetmap.org for the relationship
 * of the neighborhood of the city. If it fails it will try the entire city. With this result we
 * query overpass using the area representation of the neighborhood or city, which is the OpenStreetMap id
 * plus a magic number defined by Overpass. If the neighborhood area query fails to give us the results we want,
 * we retry with the city area
 * @param location
 * @returns {*}
 */
export const locationToQueryResults = location => {
  // Sort linestrings (ways) so we know how they are connected
  return R.compose(
    // Chain our queries until we get a result or fail
    locationsWithOsm => chainUntil(
      result => {
        // We have good results when we have exactly 2 nodes an at least 1 way
        return R.allPass(
          // Not null
          R.complement(R.isNil)(result),
          // 2 nodes
          R.compose(R.equals(2), R.prop('node')),
          // >0 ways
          R.compose(R.lt(0), R.prop('way'))
        )(result);
      },
      () => {
        return Result.Error(
          {
            error: "Unable to resolve block using the given locations with OpenStreetMap",
            locations: locationsWithOsm
          }
        );
      },
      // Creates an iterator that queries with and without neighborhood
      // Normally we only iterate once to get a good result
      queryOverpassForBlockTaskIterator(locationsWithOsm)
    ),
    // Use OSM Nominatim to get the bbox of the city. We're not currently using bbox but this at least
    // verifies that we are searching for a city that OSM knows about as an Area. We use Area to limit
    // our OSM query to the given city to make the results accurate and fast
    location => waitAll(
      R.map(
        keys => nominatimTask(R.pick(keys, location)).map(
          // bounding box comes as two lats, then two lon, so fix
          result => R.merge(location, {
            // We're not using the bbox, but note it anyway
            bbox: R.map(str => parseFloat(str), R.props([0, 2, 1, 3], result.boundingbox)),
            osmId: result.osm_id,
            placeId: result.place_id
          })
        ),
        // Query with neighborhood (if given) and without. We probably won't need the area from the without
        // query but it doesn't hurt to grab it here
        R.concat(
          R.ifElse(
            R.prop('neighborhood'),
            R.always([['country', 'state', 'city', 'neighborhood']]),
            R.always([])
          )(location)
            [['country', 'state', 'city']]
        )
      )
    )
  )(location);
};

function* queryOverpassForBlockTaskUntilFound(locationsWithOsm) {
}

const queryOverpassForBlockTask = locationWithOsm => {
  R.compose(
    ([wayResponse, nodeResponse]) => of(sortFeatures(
      wayResponse.features,
      nodeResponse.features
    )),
    // Perform the queries in parallel
    queries => waitAll(
      R.map(query => fetchOsmRawTask({}, query), queries)
    ),
    // Now build an OSM query for the location. We have to query for ways and then nodes because the API muddles
    // the geojson if we request them together
    locationsWithOsm => of(
      R.map(
        type => constructLocationQuery({type}, location),
        ['way', 'node']
      )
    )
  );
}
