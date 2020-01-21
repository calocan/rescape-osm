import * as R from 'ramda';
import {defaultRunConfig} from 'rescape-ramda';
import {blocksToGeojson} from './overpassBlockHelpers';
import grandrapids from './samples/grandrapids.json';
import {nonOsmGeojsonLinesToBlocksResultsTask} from './overpassExternalSourceBlocks';
/**
 * Created by Andy Likuski on 2019.06.14
 * Copyright (c) 2019 Andy Likuski
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */


describe('overpassAllBlocks', () => {

  test('Process geojson derived from shapefile', done => {
    const nameProp = 'SEGNAME';
    const location = {country: 'USA', state: 'MI', city: 'Grand Rapids'};
    const geojsonLines = grandrapids;
    const osmConfig = {}
    const errors = [];
    nonOsmGeojsonLinesToBlocksResultsTask({osmConfig}, {location, nameProp}, geojsonLines).run().listen(
      defaultRunConfig({
        onResolved: ({Ok: locationsWithBlocks, Error: errorBlocks}) => {
          blocksToGeojson(R.map(R.prop('block'), locationsWithBlocks));
          expect(R.length(locationsWithBlocks)).toEqual(16);
        }
      }, errors, done)
    );
  });
});
