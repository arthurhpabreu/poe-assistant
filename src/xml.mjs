import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export function parseBuild(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 8_000_000) throw Error('XML is empty or too large.');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)) throw Error('External entities and references are not allowed.');
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: e => errors.push(e), error: e => errors.push(e), fatalError: e => errors.push(e) } }).parseFromString(xml, 'text/xml');
  if (errors.length || doc.documentElement?.nodeName !== 'PathOfBuilding') throw Error('Invalid Path of Building XML.');
  if (!doc.documentElement.getElementsByTagName('Build').length) throw Error('Missing Build section.');
  // Import metadata is not necessary to edit a build and must never initiate a download.
  for (const node of Array.from(doc.getElementsByTagName('Import'))) node.parentNode.removeChild(node);
  return doc;
}
function select(doc, selector) {
  const parts = selector.split('/').filter(Boolean);
  if (parts.shift() !== 'PathOfBuilding') throw Error('Paths must start with PathOfBuilding/.');
  let nodes = [doc.documentElement];
  for (const part of parts) {
    const match = /^([A-Za-z][\w]*)(?:\[(?:(\d+)|@([\w]+)=["']([^"']*)["'])\])?$/.exec(part);
    if (!match) throw Error(`Unsupported selector: ${part}`);
    nodes = nodes.flatMap(parent => {
      let children = Array.from(parent.childNodes).filter(n => n.nodeType === 1 && n.nodeName === match[1]);
      if (match[2]) children = children.slice(Number(match[2]) - 1, Number(match[2]));
      if (match[3]) children = children.filter(n => n.getAttribute(match[3]) === match[4]);
      return children;
    });
  }
  if (nodes.length !== 1) throw Error(`Path must identify exactly one element (${nodes.length}): ${selector}`);
  return nodes[0];
}
export function applyOperations(original, operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 150) throw Error('Proposals must contain 1 to 150 operations.');
  let doc = parseBuild(original);
  for (const op of operations) {
    if (op.type === 'replace_build') { doc = parseBuild(op.value); continue; }
    const attribute = op.path?.match(/\/@([\w]+)$/);
    const node = select(doc, attribute ? op.path.slice(0, -attribute[0].length) : op.path || '');
    if (op.type === 'set_attribute') {
      if (!attribute) throw Error('set_attribute requires /@attribute.');
      node.setAttribute(attribute[1], String(op.value));
    } else if (op.type === 'set_text') {
      if (attribute) throw Error('set_text requires an element.');
      node.textContent = String(op.value);
    } else if (op.type === 'remove') {
      if (attribute) node.removeAttribute(attribute[1]);
      else if (node !== doc.documentElement && node.nodeName !== 'Build') node.parentNode.removeChild(node);
      else throw Error('Cannot remove the root or Build section.');
    } else if (op.type === 'append_xml' || op.type === 'replace_xml') {
      const wrapper = parseBuild(`<PathOfBuilding><Build/>${op.value}</PathOfBuilding>`);
      const fragments = Array.from(wrapper.documentElement.childNodes).filter(n => n.nodeType === 1 && n.nodeName !== 'Build');
      if (op.type === 'replace_xml' && fragments.length !== 1) throw Error('replace_xml requires one element.');
      if (node === doc.documentElement && op.type === 'replace_xml') throw Error('Use replace_build to replace the root.');
      for (const fragment of fragments) {
        const imported = doc.importNode(fragment, true);
        if (op.type === 'append_xml') node.appendChild(imported);
        else node.parentNode.replaceChild(imported, node);
      }
    } else throw Error(`Unknown operation: ${op.type}`);
  }
  const result = new XMLSerializer().serializeToString(doc);
  parseBuild(result);
  const before = parseBuild(original).getElementsByTagName('Build')[0].getAttribute('targetVersion');
  const after = doc.getElementsByTagName('Build')[0].getAttribute('targetVersion');
  if (before && before !== after) throw Error('Proposals cannot change the target build version.');
  return result;
}
