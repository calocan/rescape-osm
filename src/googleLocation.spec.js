/**
 * Created by Andy Likuski on 2018.03.27
 * Copyright (c) 2018 Andy Likuski
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import {
  initDirectionsService,
  createRouteFromOriginAndDestination,
  geocodeAddress,
  geojsonCenterOfBlockAddress, fullStreetNamesOfLocationTask, resolveGeojsonTask, resolveGeoLocationTask,
  geocodeBlockAddresses
} from './googleLocation';
import * as R from 'ramda';
import {defaultRunConfig, reqStrPathThrowing} from 'rescape-ramda';
import {turfPointToLocation} from 'rescape-helpers';

const austinOrigin = 'Salina St and E 21st St, Austin, TX, USA';
const austinDestination = 'Leona St and E 21st St, Austin, TX, USA';

describe('googleHelpers', () => {
  test('geocodeAddress', done => {
      geocodeAddress('Monroe St and 13th NE, Washington, DC, USA').run().listen(
        defaultRunConfig({
          onResolved:
            result => result.mapError(
              errorValue => {
                // This should not happen
                expect(R.length(errorValue.results)).toEqual(1);
                done();
              }
            ).map(
              resultValue => {
                expect(resultValue.formatted_address).toEqual('13th St NE & Monroe St NE, Washington, DC 20017, USA');
                // Make sure we can get full street names
                expect(resultValue.address_components[0].long_name).toEqual('13th Street Northeast & Monroe Street Northeast');
                done();
              }
            )
        })
      );
    },
    5000);

  test('geocodeAddressWithLatLng', done => {
      const somewhereSpecial = [60.004471, -44.663669];
      geocodeAddress(R.join(', ', somewhereSpecial)).run().listen(
        defaultRunConfig({
          onResolved:
            result => result.mapError(
              errorValue => {
                // This should not happen
                expect(R.length(errorValue.results)).toEqual(1);
                done();
              }
            ).map(
              resultValue => {
                // Reverse the point to match the geojson format
                expect(resultValue.geojson.geometry.coordinates).toEqual(R.reverse(somewhereSpecial));
                done();
              }
            )
        })
      );
    },
    5000);



  test('Resolve correct geocodeAddress with two results', done => {
    const ambiguousBlockAddresses = [
      'Monroe and 13th, Washington, DC, USA',
      'Monroe and Holmead, Washington, DC, USA'
    ];
    // Don't worry which street is listed first
    const expected = actual => R.filter(R.flip(R.contains)([
      "Monroe St NW & 13th St NW, Washington, DC 20010, USA",
      "13th St NW & Monroe St NW, Washington, DC 20010, USA",
      "Holmead Pl NW & Monroe St NW, Washington, DC 20010, USA",
      "Monroe St NW & Holmead Pl NW, Washington, DC 20010, USA"
    ]), actual);
    geocodeBlockAddresses(ambiguousBlockAddresses).run().listen(
      defaultRunConfig({
        onResolved: resultsResult => resultsResult.map(results => {
          const actual = R.map(R.prop('formatted_address'), results);
          expect(actual).toEqual(expected(actual));
          done();
        })
      })
    );
  });

  test('geocodeBlockAddress with lat/lng', done => {
    const ambiguousBlockAddresses = [
      'Monroe and 13th, Washington, DC, USA',
      '38.931990, -77.030890'
    ];
    // Don't worry which street is listed first
    const expected = actual => R.head(R.filter(R.contains(actual), [
      "Monroe St NW & 13th St NW, Washington, DC 20010, USA",
      "13th St NW & Monroe St NW, Washington, DC 20010, USA"
    ]));
    geocodeBlockAddresses(ambiguousBlockAddresses).run().listen(
      defaultRunConfig({
        onResolved: resultsResult => resultsResult.map(results => {
          const actualFirst = R.view(R.lensPath([0, 'formatted_address']), results);
          expect(actualFirst).toEqual(expected(actualFirst));
          // We expect a geojson point from the lat,lng. Flip the coordinates and stringify to match original
          const actualSecond = R.join(', ', R.reverse(R.view(R.lensPath([1, 'geojson', 'geometry', 'coordinates']), results)));
          // Turf rounds off the end 0s
          expect(actualSecond).toEqual('38.93199, -77.03089');
          done();
        })
      })
    );
  });


  test('geojsonCenterOfBlockAddress', done => {
    const blockAddresses = [
      'Monroe St NW & 13th St NW, Washington, DC, USA',
      'Monroe St NW & Holmead Pl NW, Washington, DC, USA'
    ];
    geojsonCenterOfBlockAddress(blockAddresses).run().listen(
      defaultRunConfig({
        onResolved: resultResult => resultResult.mapError(
          errorValue => {
            throw new Error(errorValue);
          }
        ).map(
          centerPoint => {
            // Finally return a simple lat, lng array
            expect(turfPointToLocation(centerPoint)).toMatchSnapshot();
            done();
          }
        )
      })
    );
  });

  test('createRouteFromOriginAndDestination', done => {
    createRouteFromOriginAndDestination(initDirectionsService(), [austinOrigin, austinDestination]).run().listen(
      defaultRunConfig({
        onResolved: routeResult => {
          routeResult.map(route => {
            expect(route.summary).toMatchSnapshot();
            done();
          });
        }
      })
    );
  });

  test('fullStreetNamesOfLocationTask', done => {
    const location = {
      country: 'USA',
      state: 'California',
      city: 'Oakland',
      // Intentionally put Grand Ave a different positions
      intersections: [['Grand Ave', 'Perkins St'], ['Lee St', 'Grand Ave']]
    };
    fullStreetNamesOfLocationTask(location).run().listen(
      defaultRunConfig({
        onResolved: response => {
          // Sort to make each pair alphabetical
          expect(R.map(R.sortBy(R.identity), response)).toEqual([
            [
              'Grand Avenue', 'Perkins Street'
            ],
            [
              'Grand Avenue', 'Lee Street'
            ]
          ]);
          done();
        }
      })
    );
  });

  test('resolveGeoLocationTask with lat/lon', done => {
    const location = {
      id: 1,
      latitude: 47,
      longitude: 1
    };
    // Resolves synchronously, but returns a Task nevertheless
    resolveGeoLocationTask(location).run().listen({
      onRejected: reject => {
        throw new Error(reject);
      },
      onResolved: responseResult => responseResult.map(response => {
        expect(response).toEqual([47, 1]);
        done();
      }).mapError(reject => {
        throw new Error(reject);
      })
    });
  });


  test('resolveGeoLocationTask with 2 intersections', done => {
    const location = {
      id: 1,
      country: 'USA',
      state: 'California',
      city: 'Oakland',
      neighborhood: 'Adams Point',
      intersections: [
        ['Grand Ave', 'Bay Pl'],
        ['Grand Ave', 'Harrison St']
      ]
    };
    resolveGeoLocationTask(location).run().listen({
      onRejected: reject => {
        throw new Error(reject);
      },
      onResolved: responseResult => responseResult.map(response => {
        expect(R.map(f => f.toFixed(2), response)).toEqual(["37.81", "-122.26"]);
        done();
      }).mapError(reject => {
        throw new Error(reject);
      })
    });
  });

  test('resolveGeoLocationFromApi', (done) => {
    // Goes to the api to resolve
    // Resolves synchronously
    const location = {
      id: 1,
      country: 'USA',
      state: 'California',
      city: 'Oakland',
      neighborhood: 'Adams Point',
      intersections: [
        ['Grand Ave', 'Bay Pl'],
        ['Grand Ave', 'Harrison St']
      ]
    };
    // Resolves asynchronously
    resolveGeoLocationTask(location).run().listen({
      onRejected: reject => {
        throw new Error(reject);
      },
      onResolved: responseResult => responseResult.map(
        response => {
          expect(R.map(f => f.toFixed(2), response)).toEqual(["37.81", "-122.26"]);
          done();
        }
      ).mapError(
        error => {
          throw new Error(error);
        }
      )
    });
  }, 2000);

  test('resolveGeojsonFromApi', (done) => {
    // Goes to the api to resolve
    // Resolves synchronously
    const location = {
      id: 1,
      country: 'USA',
      state: 'California',
      city: 'Oakland',
      neighborhood: 'Adams Point',
      intersections: [
        ['Grand Ave', 'Bay Pl'],
        ['Grand Ave', 'Harrison St']
      ]
    };
    // Resolves asynchronously
    resolveGeojsonTask(location).run().listen({
      onRejected: reject => {
        throw new Error(reject);
      },
      onResolved: responseResult => responseResult.map(
        response => {
          expect(reqStrPathThrowing('geometry.coordinates', response)).toEqual(
            [[-122.2605531, 37.810549], [-122.2623298, 37.8108424]]
          );
          done();
        }
      ).mapError(error => {
          throw new Error(error);
        }
      )
    });
  }, 20000);
});