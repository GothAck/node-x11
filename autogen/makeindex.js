var sax = require('sax')
  , fs = require('fs')
  , tsort = require('tsort')
  , count = 0;

function addToIndex(dir, index, callback, name) {
  count++;
  var header
    , parser = sax.createStream(true)
    , stream = fs.createReadStream(dir + '/' + name).pipe(parser);
  parser.on('end', function() {
     count--;
     if (count == 0)
         callback(index);
  });
  parser.on('opentag', 
    function(tag) {
       if (tag.name == 'xcb') {
          header = tag.attributes.header;
          index[header] = tag.attributes;
          index[header].file = dir + name;
          index[header].depends = []; 
          return;
       }  
    }
  );
  parser.on('closetag',
    function(tag) {
       if (tag == 'import')
       {
          index[header].depends.push(parser.lastText);
       }
    }
  );
  parser.on('text', 
    function(text) { 
       parser.lastText = text;
    }
  );
}

function grep(re, str)
{
   return str.match(re);
}

function index (dir, callback) {
  var index = {};
  fs.readdirSync(dir)
    .filter(grep.bind(null, /xml$/))
    .forEach(addToIndex.bind(null, dir, index, callback));
}
module.exports.index = index;

function sorted (callback) {
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
module.exports.sorted = sorted;
