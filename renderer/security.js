(function exposeFleetSecurity() {
  const ALLOWED_TAGS = [
    'p', 'br', 'hr', 'strong', 'em', 'del', 'mark', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'ul', 'ol', 'li', 'code', 'pre', 'a', 'img', 'table', 'thead', 'tbody',
    'tfoot', 'tr', 'th', 'td', 'input', 'span'
  ];
  const ALLOWED_ATTR = [
    'href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'checked', 'type',
    'class', 'colspan', 'rowspan'
  ];
  const SANITIZE_OPTIONS = {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'video', 'audio'],
    FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload', 'onclick', 'onmouseover'],
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|(?:fleet|sidenote)-asset:|data:image\/(?:png|jpeg|gif|webp);base64,)/i,
    // DOMPurify tests every allowed attribute that is not URI-safe against
    // ALLOWED_URI_REGEXP. Without this, type="checkbox" fails that URL test and
    // is stripped, leaving a bare <input> that renders as a text field. Same
    // for target/rel/width/height/colspan/rowspan. href and src are absent
    // here on purpose - they keep their URI validation.
    ADD_URI_SAFE_ATTR: ['type', 'target', 'rel', 'width', 'height', 'colspan', 'rowspan']
  };

  function sanitizeMarkdownHtml(html) {
    if (!window.DOMPurify) return '';
    const sanitized = window.DOMPurify.sanitize(String(html), SANITIZE_OPTIONS);
    const template = window.document.createElement('template');
    template.innerHTML = sanitized;
    template.content.querySelectorAll('img').forEach(image => {
      const src = image.getAttribute('src') || '';
      const isManagedAsset = /^(?:fleet|sidenote)-asset:/i.test(src);
      const isSafeDataImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(src);
      if (!isManagedAsset && !isSafeDataImage) image.remove();
    });
    return template.innerHTML;
  }

  function highlightSafeHtml(html, query) {
    if (!query) return sanitizeMarkdownHtml(html);
    const escaped = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const highlighted = String(html).replace(/(<[^>]*>)|([^<>]+)/g, (match, tag, text) => {
      if (tag) return tag;
      if (text) return text.replace(regex, '<mark class="search-highlight">$&</mark>');
      return match;
    });
    return sanitizeMarkdownHtml(highlighted);
  }

  window.fleetSecurity = { sanitizeMarkdownHtml, highlightSafeHtml };
})();
