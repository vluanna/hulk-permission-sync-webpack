const path = require("path");
const fs = require("fs");
const { get, omitBy, flatten, uniq, take, startCase, toArray, assign } = require('lodash')
const axios = require("axios");
const fg = require('fast-glob');
const normalizePath = require('normalize-path');

const fallbackPermissions = {
    update: 'view',
    create: 'view',
    delete: 'view',
    import: 'view',
    export: 'view',
}

const pluginName = "RequestPermissionSync";

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

const getBusinessGroup = (permissionKey = '') => {
    const businessGroupRegex = new RegExp(
        `(.*?)\.[0-9a-z]+$`,
        "i"
    );
    const matchs = businessGroupRegex.exec(permissionKey.toLowerCase())
    return matchs && matchs.length > 1 ? matchs[1] : null;
};

const parsePermissions = (permissions = {}, allPermissions = {}, fallbacks = fallbackPermissions) => {
    const mappedPermissions = Object.keys(permissions).map(key => ({ key, value: get(permissions, key) }));
    return mappedPermissions.map(permission => {
        const key = permission.key || "";
        const permissionKey = get(permission, "value[0][0]") || "";
        let permissionCode = get(permission, "value[1]") || [];
        const keyParams = key.split(".");
        const keyParamsMaxIndex = keyParams.length - 1;
        const pkeyParams = permissionKey.split(".");
        const applicationCode = pkeyParams[0] || "";
        let businessGroup = getBusinessGroup(permissionKey);

        Object.keys(fallbacks).forEach((fallItem) => {
            const fallbackRegex = new RegExp(
                `.*.${fallbacks[fallItem]}.${fallItem}`,
                "g"
            );
            if (fallbackRegex.test(permissionKey)) {
                const fallbackKey = take(pkeyParams, pkeyParams.length - 1).join(".");
                const fallbackPermission = toArray(flattenObject(allPermissions)).find(
                    (item) => get(item, "[0][0]") === fallbackKey
                );
                const fallbackPKeys =
                    (fallbackPermission && get(fallbackPermission, "[1]")) || [];
                businessGroup = getBusinessGroup(businessGroup);
                permissionCode = permissionCode.concat(fallbackPKeys);
            }
        });

        const menuLevel = keyParamsMaxIndex - 2;
        const menuName = startCase(
            (keyParams[menuLevel] || "").replace(/_/g, "-").toLowerCase()
        );
        const screenCodeItem = (keyParams[keyParamsMaxIndex - 1] || "")
            .replace(/_/g, "-")
            .toLowerCase();
        const screenCode = businessGroup + `.${screenCodeItem}`

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

const requestBodyParser = (permisionDatas, requestInfo = {}) => ({ permisionDatas, requestInfo })

const isDisabled = (compilerOptions) => {
    return compilerOptions.mode !== 'production'
}

module.exports = class RequestPermissionSync {
    static defaultOptions = {
        filename: "permissions.json",
        permissions: {},
        fallbackPermissions,
        tests: [
            /(?<=\hasPermissions\([\w\d]+\.).*?(?=\))/g,
            /(?<=\usePermissions\([\w\d]+\.).*?(?=\))/g,
            /(?<=\withPermissions\([\w\d]+\.).*?(?=\))/g,
            /(?<=\hasPermissions\:[\w\d]+\.).*?(?=[\,])/g
        ],
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
        this.options = {
            ...RequestPermissionSync.defaultOptions,
            ...options,
            tests: RequestPermissionSync.defaultOptions.tests.concat(options.tests || []),
            fallbackPermissions: Object.assign(RequestPermissionSync.defaultOptions.fallbackPermissions || {}, options.fallbackPermissions || {})
        };
        this.matchKeys = [];
    }
    apply(compiler) {
        const isIncludeHtml = this.options.fileExtensions.includes('html');
        let isBypassed = false;
        if (typeof this.options.isDisabled === 'boolean') {
            isBypassed = this.options.isDisabled
        } else if (typeof this.options.isDisabled === 'function') {
            isBypassed = this.options.isDisabled(compiler.options)
        }
        if (isBypassed) return

        let outputPath;

        const processFile = (filePath, sourceCode) => {
            if (!filePath) {
                return;
            }

            const srcFolderPath = normalizePath(path.resolve(this.options.sourceFolder));
            const filePathNormalized = normalizePath(filePath);
            if (filePathNormalized && filePathNormalized.startsWith(srcFolderPath)
                && this.options.fileExtensions.some(item => filePathNormalized.endsWith(`.${item}`))
            ) {
                this.options.tests.forEach(regex => {
                    const matchKeys = sourceCode.match(regex)
                    if (matchKeys && matchKeys.length) {
                        this.matchKeys = this.matchKeys.concat(matchKeys)
                    }
                })
            }
        }

        if (isIncludeHtml) {
            compiler.hooks.beforeCompile.tapAsync(pluginName, async (params, callback) => {
                try {
                    const entriesPath = normalizePath(path.resolve(path.join(this.options.sourceFolder, '**/*.html')));
                    const entries = await fg([entriesPath]);
                    entries.forEach(filePath => {
                        const content = fs.readFileSync(filePath, 'utf8');
                        processFile(filePath, content)
                    })
                } catch (error) {
                    console.log(pluginName, 'HTML FILE ERROR', error)
                    callback();
                }
                callback();
            });
        }

        compiler.hooks.compilation.tap(pluginName, (compilation) => {
            outputPath = compilation.outputOptions.path;

            const tapCallbackProcess = (normalModule) => {
                return processFile(normalModule.resource, get(normalModule, '_source._value') || '');
            }

            compilation.hooks.succeedModule.tap(pluginName, tapCallbackProcess);

        });

        compiler.hooks.done.tap(pluginName, async () => {
            if (this.matchKeys.length) {
                const allPermissions = this.options.permissions || {}
                const usedPermissions = getUsedPermissions(this.matchKeys, allPermissions)
                const permissions = parsePermissions(usedPermissions, allPermissions, this.options.fallbackPermissions)
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
