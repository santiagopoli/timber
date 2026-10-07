# Console components

AI Elements components are vendored from the official registry at
https://elements.ai-sdk.dev/api/registry/ and their shadcn/ui dependencies from
https://ui.shadcn.com/r/styles/new-york-v4/. `components.sources.json` records each
source URL and original source hash. These are the real source components; only
the conversation mounts in React, while the existing controller owns transport.

Local adaptations: import aliases target this workspace; MessageResponse uses
Streamdown without the optional math/Mermaid/syntax plugins, keeping ordinary
Markdown, tables, lists and code local under the existing strict CSP. Message HTML
and remote images are disabled by the chat consumer.

## AI Elements license

Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## shadcn/ui license

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## noVNC

The live desktop viewer bundles @novnc/novnc 1.7.0, licensed under Mozilla Public License 2.0.
Upstream source and license: https://github.com/novnc/noVNC/tree/v1.7.0
Timber imports the unmodified npm package; its source remains available upstream.

The noVNC package also retains its upstream third-party notices in its published
source distribution (including vendor codecs). See its LICENSE.txt and AUTHORS.
