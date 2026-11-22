import { TodoistApi } from '@todoist/sdk'
import { toFetchResponse } from '../utils/test-helpers.js'
import { importProjectTemplate } from './import-project-template.js'

describe('CSV template import through the real SDK', () => {
    it('sends CSV bytes as a multipart file rather than opening them as a path', async () => {
        const csv =
            '\uFEFFTYPE,CONTENT,DESCRIPTION,INDENT\r\ntask,"État, prêt","Ligne 1\nLigne 2",1\r\n'
        let sentFile: { request: string; name: string; content: string } | undefined
        const client = new TodoistApi('unused-test-token', {
            baseUrl: 'https://todoist.invalid',
            customFetch: async (url, init) => {
                const form = await new Response(init?.body, { headers: init?.headers }).formData()
                const file = form.get('file')
                if (!(file instanceof File)) throw new Error('CSV file part is missing')
                sentFile = {
                    request: `${init?.method} ${new URL(url).pathname}`,
                    name: file.name,
                    content: Buffer.from(await file.arrayBuffer()).toString('utf8'),
                }
                return toFetchResponse({
                    status: 'ok',
                    template_type: 'project',
                    projects: [],
                    sections: [],
                    tasks: [],
                    comments: [],
                })
            },
        })

        const result = await importProjectTemplate.execute(
            { projectId: 'test-project', csvFileContent: csv },
            client,
        )

        expect(sentFile).toEqual({
            request: 'POST /api/v1/projects/test-project/import',
            name: 'template.csv',
            content:
                '\uFEFFTYPE,CONTENT,DESCRIPTION,INDENT\r\ntask,"État, prêt","Ligne 1\nLigne 2",1\r\n',
        })
        expect(result.structuredContent?.totalCount).toBe(0)
    })
})
