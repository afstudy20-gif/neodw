type XmlAttrs = Record<string, string | number | boolean | null | undefined>;

class XmlNodeBuilder {
  public children: XmlNodeBuilder[] = [];
  private attributes: XmlAttrs = {};
  private textValue = '';

  constructor(
    private name: string,
    attrs: XmlAttrs = {},
  ) {
    this.attributes = attrs;
  }

  ele(name: string, attrs: XmlAttrs = {}) {
    const child = new XmlNodeBuilder(name, attrs);
    this.children.push(child);
    return child;
  }

  att(name: string, value: string | number | boolean | null | undefined) {
    this.attributes[name] = value;
    return this;
  }

  txt(value: string | number) {
    this.textValue += String(value);
    return this;
  }

  end(options: { pretty?: boolean } = {}) {
    return this.serialize(options.pretty ? 0 : undefined);
  }

  private serialize(indent?: number): string {
    const pretty = indent !== undefined;
    const pad = pretty ? '  '.repeat(indent) : '';
    const childIndent = pretty ? indent + 1 : undefined;
    const attrs = Object.entries(this.attributes)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
      .join('');

    if (!this.children.length && !this.textValue) {
      return `${pad}<${this.name}${attrs}/>`;
    }

    const text = this.textValue ? escapeXml(this.textValue) : '';
    const children = this.children.map((child) => child.serialize(childIndent));

    if (!pretty || !children.length) {
      return `${pad}<${this.name}${attrs}>${text}${children.join('')}</${this.name}>`;
    }

    return `${pad}<${this.name}${attrs}>${text ? `\n${'  '.repeat(indent + 1)}${text}` : ''}\n${children.join('\n')}\n${pad}</${this.name}>`;
  }
}

class XmlDocumentBuilder {
  private documentRoot: XmlNodeBuilder | null = null;

  ele(name: string, attrs: XmlAttrs = {}) {
    this.documentRoot = new XmlNodeBuilder(name, attrs);
    return this.documentRoot;
  }
}

class DomNodeWrapper {
  constructor(public node: Element) {}

  filter(predicate: (node: DomNodeWrapper) => boolean, _deep = false, recursive = false) {
    const nodes = recursive ? Array.from(this.node.getElementsByTagName('*')) : Array.from(this.node.children);
    return nodes.map((node) => new DomNodeWrapper(node)).filter(predicate);
  }
}

class ParsedXmlDocument {
  constructor(private document: Document) {}

  root() {
    return new DomNodeWrapper(this.document.documentElement);
  }
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function create(xml?: string) {
  if (typeof xml === 'string') {
    const parser = new DOMParser();
    return new ParsedXmlDocument(parser.parseFromString(xml, 'application/xml'));
  }

  return new XmlDocumentBuilder();
}
