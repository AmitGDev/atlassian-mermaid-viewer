# Changelog

All notable changes to Atlassian Mermaid Viewer are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] - 2026-11-02

### Changed

- Upgraded the bundled Mermaid from v11 to v12.2.0.
- Diagram type detection now matches the leading keyword as a whole word instead of a keyword followed by a space. A keyword alone on the first line (for example `pie`) is detected, suffix variants such as `-beta` and `-elk` need no separate entries, and prose that merely starts with a keyword prefix (for example `graphite ...`) is no longer mistaken for a diagram.

### Added

- Support for the diagram types missing from the previous keyword list:
  - `journey`, `quadrantChart`, `requirementDiagram`, `mindmap`, `timeline`
  - `C4Context`, `C4Container`, `C4Component`, `C4Dynamic`, `C4Deployment`
  - `sankey`, `xychart`, `block`, `packet`, `kanban`, `architecture`, `radar`, `treemap`, `treeView`
  - `wardley`, `cynefin`, `usecase`, `venn`, `swimlane`, `ishikawa`, `eventmodeling`
  - `railroad`, in all four notations: `railroad-ebnf-beta`, `railroad-abnf-beta`, `railroad-peg-beta` and `railroad-beta`
- Detection of diagrams that start with frontmatter (`---`), a `%%{init}%%` directive or a `%%` comment before the diagram keyword. Styled diagrams were never detected before.

### Fixed

- Class diagram note text being clipped on the left, losing the first characters of each line, when the label was wider than its box (AMV-46).
- A Mermaid error diagram (the bomb icon) being left at the bottom of the page for every diagram with a syntax error. The temporary element that Mermaid appends to the page is now removed, and only the inline error message is shown.

### Security

- Diagram error messages are now rendered as plain text instead of HTML. The message embeds diagram source written by whoever edited the page, so rendering it as HTML allowed markup injection into the page context.

## [1.1.0] - 2026-05-26

### Added

- Central configuration override. The viewer reads its configuration from a Confluence config page in the AMVCENTRAL space, where the settings are a JSON document in a code snippet block.
- HTML line breaks (`<br/>`) in diagram labels need a central configuration where `securityLevel` is not `strict`.

## [1.0.0] - 2026-05-21

### Added

- Initial release, bundling Mermaid 11.0.0.
- Rendering of Mermaid diagrams written in no-language code snippet blocks in Confluence and Jira, identified by the diagram keyword at the start of the snippet.
- Support for the basic diagram types: `graph`, `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram`, `gantt`, `pie` and `gitGraph`.