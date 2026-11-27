// Reads a shell command into the simple commands it runs, without running any of it. The push
// check uses it to find the `git push` and `gh pr create` calls in an agent's shell command.

/** A simple command's words, or the edges of a subshell, `$(...)` or backtick command. */
export type ShellItem = { type: 'command'; words: string[] } | { type: 'enter' } | { type: 'leave' }

type Level = { word: string; started: boolean; skip: boolean; words: string[] }

/** What the reader is inside of: a command (the top level, `$(...)` or `(...)`), a backtick
 * command, or single or double quotes. */
type Context = 'command' | 'backtick' | 'single' | 'double'

function newLevel(): Level {
    return { word: '', started: false, skip: false, words: [] }
}

/**
 * The simple commands a shell command runs, in order. Quotes come off each word. `$(...)`, `(...)`
 * and backticks hold commands of their own, between an `enter` and a `leave`, since a `cd` inside
 * them stays there, and leave `$` in the word around them. Here-documents, redirections and
 * comments are left out. Shell it doesn't follow only makes odd words, which never look like a
 * push.
 */
export function readCommands(source: string): ShellItem[] {
    const items: ShellItem[] = []
    const levels: Level[] = [newLevel()]
    const context: Context[] = ['command']
    const hereDocuments: { name: string; tabs: boolean }[] = []
    let joined = false

    function level(): Level {
        return levels[levels.length - 1] as Level
    }
    function inside(): Context {
        return context[context.length - 1] as Context
    }
    function add(text: string): void {
        level().word += text
        level().started = true
    }
    function endWord(): void {
        const current = level()
        if (current.started) {
            if (current.skip) current.skip = false
            else current.words.push(current.word)
        }
        current.word = ''
        current.started = false
    }
    function endCommand(): void {
        endWord()
        if (level().words.length > 0) items.push({ type: 'command', words: level().words })
        levels[levels.length - 1] = newLevel()
    }
    function enter(kind: Context): void {
        items.push({ type: 'enter' })
        context.push(kind)
        levels.push(newLevel())
    }
    function leave(): void {
        endCommand()
        items.push({ type: 'leave' })
        context.pop()
        levels.pop()
    }

    for (const rawLine of source.split('\n')) {
        // A here-document runs from the line after its `<<` to its delimiter.
        const [document] = hereDocuments
        if (document) {
            const line = document.tabs ? rawLine.replace(/^\t+/, '') : rawLine
            if (line === document.name) hereDocuments.shift()
            continue
        }
        const line = rawLine
        for (let i = 0; i < line.length; i++) {
            const kind = inside()
            const c = line[i] as string
            const next = line[i + 1]
            if (kind === 'single') {
                if (c === "'") context.pop()
                else add(c)
                continue
            }
            if (kind === 'double') {
                if (c === '\\' && next !== undefined && '$`"\\'.includes(next)) {
                    add(next)
                    i++
                } else if (c === '"') context.pop()
                else if (c === '$' && next === '(') {
                    add('$')
                    i++
                    enter('command')
                } else if (c === '`') {
                    add('$')
                    enter('backtick')
                } else add(c)
                continue
            }
            if (c === '\\') {
                if (next !== undefined) {
                    add(next)
                    i++
                } else joined = true
            } else if (c === "'") {
                context.push('single')
                level().started = true
            } else if (c === '"') {
                context.push('double')
                level().started = true
            } else if (c === '`') {
                if (kind === 'backtick') leave()
                else {
                    add('$')
                    enter('backtick')
                }
            } else if (c === '$') {
                add('$')
                if (next === '(') {
                    i++
                    enter('command')
                }
            } else if (c === '(') {
                endCommand()
                enter('command')
            } else if (c === ')') {
                if (context.length > 1 && kind === 'command') leave()
                else endCommand()
            } else if (c === ' ' || c === '\t') {
                endWord()
            } else if (c === '#') {
                if (level().started) add('#')
                else break
            } else if (c === '<' && next === '<' && line[i + 2] !== '<') {
                const { name, tabs, end } = readHereDocument(line, i + 2)
                if (name) hereDocuments.push({ name, tabs })
                i = end
            } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
                // A file descriptor before the operator belongs to it, and the next word is where
                // it goes.
                if (/^[0-9]+$/.test(level().word)) {
                    level().word = ''
                    level().started = false
                } else endWord()
                while (i + 1 < line.length && '<>&|'.includes(line[i + 1] as string)) i++
                level().skip = true
            } else if (c === ';' || c === '&' || c === '|') {
                endCommand()
            } else {
                add(c)
            }
        }
        const kind = inside()
        if (kind === 'single' || kind === 'double') add('\n')
        else if (joined) joined = false
        else endCommand()
    }
    while (context.length > 1) {
        const kind = inside()
        if (kind === 'single' || kind === 'double') context.pop()
        else leave()
    }
    endCommand()
    return items
}

/** The delimiter of a here-document whose `<<` ends just before `start`. */
function readHereDocument(
    line: string,
    start: number,
): { name: string; tabs: boolean; end: number } {
    let i = start
    let tabs = false
    let name = ''
    if (line[i] === '-') {
        tabs = true
        i++
    }
    while (line[i] === ' ' || line[i] === '\t') i++
    while (i < line.length) {
        const c = line[i] as string
        if (c === "'" || c === '"') {
            const close = line.indexOf(c, i + 1)
            if (close === -1) {
                name += line.slice(i + 1)
                i = line.length
                break
            }
            name += line.slice(i + 1, close)
            i = close + 1
            continue
        }
        if (c === '\\') {
            name += line[i + 1] ?? ''
            i += 2
            continue
        }
        if (' \t;&|()<>'.includes(c)) break
        name += c
        i++
    }
    return { name, tabs, end: i - 1 }
}
