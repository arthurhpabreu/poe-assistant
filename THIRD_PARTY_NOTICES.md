# Third-party notices

PoE Assistant's original code and original documentation artwork are licensed
under the MIT license in `LICENSE`. Third-party names, trademarks, screenshots
and software retain their respective owners' rights.

## Software included in Windows installers

| Component | License | License text in the installed release |
| --- | --- | --- |
| Node.js and its bundled components | MIT and component-specific notices | `runtime/LICENSE-node.txt` (the complete license from the exact bundled Node version) |
| @xmldom/xmldom | MIT | `node_modules/@xmldom/xmldom/LICENSE` |

The packaging script preserves the complete xmldom package and downloads the
Node license for the exact runtime being bundled. These components keep their
own copyright notices; PoE Assistant's license does not replace them.

## Software used separately

Path of Building Community Fork is installed separately. Its source code,
runtime, game database and game artwork are **not** included in this addon's
installer. PoE Assistant reads the user's installed copy and creates isolated
local calculator workers. Path of Building retains its [own license and
third-party notices](https://github.com/PathOfBuildingCommunity/PathOfBuilding/blob/dev/LICENSE.md).
The upstream project is credited to David Gowor and the Path of Building
Community contributors. Any upstream-derived integration portions remain
covered by its MIT notice: Copyright (c) 2016 David Gowor, with the permission
and warranty terms reproduced in this project's `LICENSE`.

Claude Code and Codex CLI are installed and authenticated separately. Their
respective providers' terms and licenses apply; neither CLI is bundled.

## Development dependencies

Fengari (MIT) and its development dependency licenses remain in their packages.
Development dependencies are not included in the Windows installer. See
`package-lock.json` for resolved versions and license identifiers.

## Names and screenshots

Path of Exile and its game artwork belong to Grinding Gear Games. Path of
Building, Anthropic, Claude, OpenAI, Codex and GitHub names belong to their
respective owners. Screenshots show the addon running with a separately
installed PoB. This community project is not affiliated with or endorsed by
Grinding Gear Games, Path of Building Community, Anthropic or OpenAI.
