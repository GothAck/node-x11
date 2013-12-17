var tsort = require('tsort')
  , index = require('./makeindex');

function makeGraph (callback) {
  var graph = tsort();
  index('./proto/', function(index) {
    Object.keys(index).forEach(function (name) {
      var idx = index[name];
      idx.depends.forEach(function (dep) {
        console.log(idx.header, dep)
        graph.add(idx.header, dep);
      });
    });
    callback(
      graph.sort().reverse().map(function (header) {
        return index[header];
      })
    )
  });
}
module.exports = makeGraph;

if (require.main === module)
  makeGraph(function (sorted) {
    console.log('Load in this order');
    console.log(sorted);
  });
