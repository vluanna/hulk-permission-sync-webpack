# hulk-permission-sync-webpack
A webpack plugin to sync permissions to service on deploy
before build (or after, or any other [event hook](https://webpack.js.org/api/compiler-hooks/)). 
Can stop compilation by condition.

## Installation

```
npm install --save-dev @cloudhms/hulk-permission-sync-webpack
```

## Usage

In config file:

``` javascript
const HulkPermissionSync = require('hulk-permission-sync-webpack');
// ...
  module: {
    plugins: [
      new HulkPermissionSync({
        filename: "permissions.json", // to create a json file on compile on output folder, optional,
        permissions: {}, // all permission keys object in you app
        fallbackPermissions: { update: "view", create: "view" }, // this will fallback update and create permissions includes view permissions
        tests: [/(?<=\hasPermissions\([\w\d]+\.).*?(?=\))/g], // regexes to test content in files with have used permission keys
        fileExtensions: ['js', 'jsx'], // file ext to check on
        sourceFolder: 'src',
        // Axios options...
        requestOptions: {
          url: 'http://some.url/to/post/your/permissions',
          method: 'post',
          headers: { 'Content-Type': 'application/json' },
          bodyParser: (permisionDatas) => ({ permisionDatas }), // parser function to parse permissions to axios data body
        },
        isDisabled: false, // this config will disable the plugin to run on compile
      }),
    ]
  },
// ...
```


You can find other axios's API options [here](https://github.com/axios/axios#axios-api)

By default, url will load from process env or sysconfig: PERMISSION_SYNC_URL
