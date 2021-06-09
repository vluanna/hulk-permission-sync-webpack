const path = require("path");
const fs = require("fs");
const { get, omitBy, flatten, uniq, take, startCase, toArray } = require('lodash')
const axios = require("axios");

const fallbackPermissions = {
    update: 'view',
    create: 'view',
    delete: 'view',
}

const pluginName = "HulkPermissionSync";

const flattenObject = (ob) => {
    var toReturn = {};
    for (var i in ob) {
        if (!ob.hasOwnProperty(i)) continue;
        if ((typeof ob[i]) == 'object' && ob[i] !== null && !Array.isArray(ob[i])) {
            var flatObject = flattenObject(ob[i]);
            for (var x in flatObject) {
                if (!flatObject.hasOwnProperty(x)) continue;
                toReturn[i + '.' + x] = flatObject[x];
            }
        } else {
            toReturn[i] = ob[i];
        }
    }
    return toReturn;
}

const getUsedPermissions = (keys = [], permissions = {}) => {
    const flattenPermissions = flattenObject(permissions);
    const usedPermissionCodes = uniq(flatten(keys.map(item => get(permissions, item))));
    return omitBy(flattenPermissions, value => {
        return (get(value, '[0]') || []).some(key => usedPermissionCodes.indexOf(key) < 0)
    })
}

const parsePermissions = (permissions = {}, allPermissions = {}, childLevelCount = 3, fallbacks = fallbackPermissions) => {
    const mappedPermissions = Object.keys(permissions).map(key => ({ key, value: get(permissions, key) }));

    return mappedPermissions.map(permission => {
        const key = permission.key || '';
        const permissionKey = get(permission, 'value[0][0]') || '';
        let permissionCode = get(permission, 'value[1]') || [];
        const keyParams = key.split('.');
        const pkeyParams = permissionKey.split('.');
        const applicationCode = pkeyParams[0] || '';
        const businessGroup = take(pkeyParams, childLevelCount).join('.')
        const menuLevel = childLevelCount - 1;
        const menuName = startCase((keyParams[menuLevel] || '').replace(/_/g, '-').toLowerCase());
        const screenCodeItem = (keyParams[childLevelCount] || '').replace(/_/g, '-').toLowerCase();
        const screenCode = take(pkeyParams, childLevelCount).concat([screenCodeItem]).join('.');

        Object.keys(fallbacks).forEach(fallItem => {
            const fallbackRegex = new RegExp(`.*.${fallbacks[fallItem]}.${fallItem}`, 'g')
            if (fallbackRegex.test(permissionKey)) {
                const fallbackKey = take(pkeyParams, pkeyParams.length - 1).join('.');
                const fallbackPermission = toArray(flattenObject(allPermissions)).find(item => get(item, '[0][0]') === fallbackKey)
                const fallbackPKeys = fallbackPermission && get(fallbackPermission, '[1]') || []
                permissionCode = permissionCode.concat(fallbackPKeys)
            }
        })

        return {
            applicationCode,
            businessGroup,
            businessGroupPermission: permissionKey,
            permissionCode,
            menuName,
            screenCode,
            screenName: startCase(screenCodeItem)
        }
    })
}

const requestBodyParser = (permisionDatas) => ({ permisionDatas })

const isDisabled = (compilerOptions) => {
    return compilerOptions.mode !== 'production'
}

module.exports = class HulkPermissionSync {
    static defaultOptions = {
        filename: "permissions.json",
        permissions: {},
        fallbackPermissions,
        childLevelCount: 3,
        tests: [
            /(?<=\hasPermissions\([\w\d]+\.).*?(?=\))/g,
            /(?<=\usePermissions\([\w\d]+\.).*?(?=\))/g,
            /(?<=\withPermissions\([\w\d]+\.).*?(?=\))/g],
        fileExtensions: ['js', 'jsx', 'ts', 'tsx'],
        sourceFolder: 'src',
        requestOptions: {
            url: process.env.PERMISSION_SYNC_URL,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            bodyParser: requestBodyParser
        },
        isDisabled,
    };
    constructor(options = {}) {
        this.options = { ...HulkPermissionSync.defaultOptions, ...options };
        this.matchKeys = [];
    }
    apply(compiler) {
        let isBypassed = false;
        if (typeof this.options.isDisabled === 'boolean') {
            isBypassed = this.options.isDisabled
        }
        if (typeof isDisabled === 'function') {
            isBypassed = this.options.isDisabled(compiler.options)
        }
        if (isBypassed) return

        let outputPath;

        compiler.hooks.compilation.tap(pluginName, (compilation) => {
            outputPath = compilation.outputOptions.path;
            const tapCallbackProcess = (normalModule) => {
                if (normalModule.resource && normalModule.resource.startsWith(path.resolve(this.options.sourceFolder))
                    && this.options.fileExtensions.some(item => normalModule.resource.endsWith(`.${item}`))
                ) {
                    const sourceCode = get(normalModule, '_source._value') || '';
                    this.options.tests.forEach(regex => {
                        const matchKeys = sourceCode.match(regex)
                        if (matchKeys && matchKeys.length) {
                            this.matchKeys = this.matchKeys.concat(matchKeys)
                        }
                    })
                }
            }
            compilation.hooks.succeedModule.tap(pluginName, tapCallbackProcess);
        });

        compiler.hooks.done.tap(pluginName, async () => {
            if (this.matchKeys.length) {
                const allPermissions = this.options.permissions || {}
                const usedPermissions = getUsedPermissions(this.matchKeys, allPermissions)
                const permissions = parsePermissions(usedPermissions, allPermissions, this.options.childLevelCount, this.options.fallbackPermissions)
                if (this.options.filename) {
                    try {
                        fs.writeFileSync(
                            path.join(outputPath, this.options.filename),
                            JSON.stringify(permissions)
                        );
                    } catch (error) {
                        console.warn(`${pluginName} Write permmission file ERROR:` + String(error))
                    }
                }
                try {
                    const requestOptions = Object.assign(this.options.requestOptions, {
                        url: this.options.requestOptions.url || process.env.PERMISSION_SYNC_URL,
                        data: (this.options.requestOptions.bodyParser || requestBodyParser)(permissions),
                    })
                    const resp = await axios(requestOptions);
                    const version = get(resp, 'data.responseInfo.version') || 'unknown'
                    if (get(resp, 'data.data')) {
                        console.log(`${pluginName} Permissions import success ${permissions.length} records\nVersion ${version}`)
                    } else {
                        throw new Error(`Cannot sync permissions: ${JSON.stringify(get(resp, 'data.errors') || get(resp, 'data'))}\nVersion ${version}`);
                    }
                } catch (error) {
                    throw new Error(`${pluginName}: ${String(error)}`);
                }
            }
        })
    }
};
