// Helpers de consulta ao D1 pro módulo Financeiro/Dados Cadastrais.

export async function getClientBySlug(db, slug) {
  return db.prepare('SELECT * FROM clients WHERE slug = ?').bind(slug).first();
}

export async function getInvoicesForClient(db, clientId) {
  const { results: invoices } = await db
    .prepare('SELECT id, label, status, paid, due_date, paid_date FROM invoices WHERE client_id = ? ORDER BY due_date DESC')
    .bind(clientId)
    .all();

  if (invoices.length === 0) return [];

  const { results: links } = await db
    .prepare(
      `SELECT invoice_links.invoice_id, invoice_links.kind, invoice_links.url
       FROM invoice_links
       JOIN invoices ON invoices.id = invoice_links.invoice_id
       WHERE invoices.client_id = ?`,
    )
    .bind(clientId)
    .all();

  const linksByInvoice = new Map();
  for (const link of links) {
    if (!linksByInvoice.has(link.invoice_id)) linksByInvoice.set(link.invoice_id, {});
    linksByInvoice.get(link.invoice_id)[link.kind] = link.url;
  }

  return invoices.map(inv => ({
    label: inv.label,
    paid: !!inv.paid,
    dueDate: inv.due_date,
    paidDate: inv.paid_date,
    links: linksByInvoice.get(inv.id) || {},
  }));
}
