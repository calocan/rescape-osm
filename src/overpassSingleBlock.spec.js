import {queryLocationForOsmSingleBlockResultTask} from './overpassSingleBlock';
import {defaultRunToResultConfig, reqStrPathThrowing} from 'rescape-ramda';
import * as R from 'ramda';

/**
 * Created by Andy Likuski on 2019.06.14
 * Copyright (c) 2019 Andy Likuski
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */


describe('overpassSingleBlock', () => {

  test('fetchLatLonOnyLocation', done => {
    const errors = [];
    expect.assertions(4);
    const osmConfig = {};
    queryLocationForOsmSingleBlockResultTask(osmConfig, {
      intersections: ['40.6660816,-73.8057879', '40.66528,-73.80604']
    }).run().listen(defaultRunToResultConfig(
      {
        onResolved: ({results, location}) => {
          expect(R.prop('locationPoints', location)).toEqual(
            [
              {
                'type': 'Feature',
                'properties': {},
                'geometry': {
                  'type': 'Point',
                  'coordinates': [
                    -73.8057879,
                    40.6660816
                  ]
                }
              },
              {
                'type': 'Feature',
                'properties': {},
                'geometry': {
                  'type': 'Point',
                  'coordinates': [
                    -73.80604,
                    40.66528
                  ]
                }
              }
            ]
          );
          // Expect it to be two ways
          expect(R.map(R.prop('id'), R.prop('ways', results))).toEqual(['way/5707230']);
          expect(R.map(R.prop('id'), R.prop('nodes', results))).toEqual(['node/42875319', 'node/42901997']);
          // Expect our intersection names
          expect(reqStrPathThrowing('intersections', results)).toEqual({
            'node/42875319': [
              '134th Street',
              'South Conduit Avenue'
            ],
            'node/42901997': [
              '134th Street',
              '149th Avenue'
            ]
          });
        }
      }, errors, done));
  }, 20000);

  test('fetchLatLonOnyLocationForPedestrianArea', done => {
    // This is where the block is a pedestrian area, not a simple line.
    const errors = [];
    expect.assertions(3);
    const osmConfig = {};
    queryLocationForOsmSingleBlockResultTask(osmConfig, {
      intersections: ['59.952305, 11.047053', '59.952248, 11.045588']
    }).run().listen(defaultRunToResultConfig(
      {
        onResolved: ({results, location}) => {
          // Expect it to be two ways
          expect(R.map(R.prop('id'), R.prop('ways', results))).toEqual(['way/570781859']);
          expect(R.map(R.prop('id'), R.prop('nodes', results))).toEqual(['node/706705268', 'node/1287797787']);
          // Expect our intersection names
          expect(reqStrPathThrowing('intersections', results)).toEqual({
            'node/706705268': [
              'way/570781859',
              'Tærudgata'
            ],
            'node/1287797787': [
              'way/570781859',
              'way/703449786'
            ]
          });
        }
      }, errors, done));
  }, 50000);


  test('fetchWhereGoogleResolvesLocationPoints', done => {
    // This is where the block is a pedestrian area, not a simple line.
    const errors = [];
    expect.assertions(3);
    const osmConfig = {};
    queryLocationForOsmSingleBlockResultTask(osmConfig, {
      'intersections': [['High St', 'Durham St E'], ['High St', 'Victoria St E']],
      'neighborhood': 'Viaduct Basin',
      'city': 'Auckland',
      'country': 'New Zealand'
    }).run().listen(defaultRunToResultConfig(
      {
        onResolved: ({results, location}) => {
          expect(R.length(R.prop('nodes', results))).toEqual(2);
          expect(R.length(R.prop('ways', results))).toEqual(1);

          expect(R.prop('locationPoints', location)).toEqual([
            {
              'type': 'Feature',
              'properties': {},
              'geometry': {
                'type': 'Point',
                'coordinates': [
                  174.7663471,
                  -36.8485059
                ]
              }
            },
            {
              'type': 'Feature',
              'properties': {},
              'geometry': {
                'type': 'Point',
                'coordinates': [
                  174.7661018,
                  -36.8492513
                ]
              }
            }
          ]);
        }
      }, errors, done));
  }, 50000);


});

