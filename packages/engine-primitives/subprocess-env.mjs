// Core-owned engine primitive.
export function minimalSubprocessEnvironment() {
    const environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8' };
    for (const key of ['LC_ALL', 'LC_CTYPE'])
        if (process.env[key])
            environment[key] = process.env[key];
    if (process.platform === 'win32')
        for (const key of ['ComSpec', 'SystemRoot', 'PATHEXT'])
            if (process.env[key])
                environment[key] = process.env[key];
    return environment;
}
