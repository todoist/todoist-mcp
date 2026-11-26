import type { TodoistSkill } from './todoist-skill.js'

export const templates: TodoistSkill = {
    name: 'templates',
    files: {
        'SKILL.md': `---
name: templates
description: Work with Todoist project templates. Find one, start a project from it, add it to an existing project, save a project or CSV as a template, edit a saved template, or export a project as CSV. Use whenever the user mentions templates, wants to reuse or duplicate a project's structure, or has CSV to bring into Todoist.
---

# Templates

A template holds a project's layout, sections, tasks and comments. Gallery templates come from Todoist and are named by a slug ("product-launch"); saved templates belong to the user or a workspace and have an ID ("UT_..."). Every tool that takes a template also accepts a Todoist template URL.

## Find one

When the user names a template without its ID or URL, search for it with **find-templates**. Its source is "todoist" for the gallery, "user" for personal templates and "workspace" for templates saved to the user's workspaces; leave it out to search all three.

To show what a template contains before using it, call **fetch-object** with type "template".

## Start from one

- New project: **add-projects** with templateId. Alongside a template, only name, workspace, folderId and locale apply.
- Existing project: **import-into-project** with projectId and templateId. It adds the template's sections and tasks to whatever the project already holds.

Both write immediately and cannot be undone, so confirm the template and, for an import, the target project with the user first.

## Save one

**add-template** saves a reusable template in the user's Todoist from a project (projectId), from CSV (csvFileContent) or from scratch.

1. Call it without preview, which defaults to true, to get the draft.
2. Show the draft and ask what to change, even when the user described the whole template, unless they said to save it as is.
3. Save with preview false, a name and a description. If the draft was edited, send all of it as content: anything left out is not saved.

Each save creates a new template, and templates cannot be deleted with these tools. To fix a mistake after saving, edit the saved template rather than saving again.

## Edit one

**update-template** renames a saved template, changes its description or colour, moves a personal template into a workspace, shares a workspace template with its members, or replaces the content. Gallery templates cannot be edited.

To change what a template contains:

1. Fetch it with fetch-object, type "template".
2. Edit that content and send all of it back as update-template's content. Anything left out is removed.
3. Task IDs change on every save, so fetch the template again before the next edit.

To rebuild a template from a project's current state, pass the projectId to update-template instead of content.

## Export a project

**export-project** returns a project as CSV. With format "file" it returns the CSV itself, which import-into-project and add-template both accept as csvFileContent, so this is how to copy a project's structure into another project. With format "url" it uploads the CSV and returns a link that is public, permanent and cannot be revoked: use that only when the user asks for a link, and tell them so.

Set useRelativeDates to export due dates relative to the import date ("day 3"), for a project meant to be reused.
`,
    },
}
