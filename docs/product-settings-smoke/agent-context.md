# Soho Home CP Feature Docs Agent Context

Generated: 2026-06-27T20:56:04.632Z

Use this file as the handoff for Codex to produce final operator documentation. Read the referenced controller, model, XML, and view files before finalising page purpose, field behaviour, validation, and side effects.

## Product Settings

- URL: https://dev.soho-home.local/cp/product-settings-admin
- Draft doc: pages/001-cp-product-settings-admin-31616840/README.md
- Page screenshots: pages/001-cp-product-settings-admin-31616840/images/page-desktop.png
- Field count: 29
- Controller: Soho\Products\Base\SettingsControllerAdmin (product-settings-admin)
- Controller file: vendor/soho/products/src/SettingsControllerAdmin.php
- Action method: indexAction
- Model: Product_Settings => App\Products\Model\Settings
- Model file: src/Products/Model/Settings.php
- Model XML: src/Products/Model/Settings.xml
- Model item prefix: settings

### DOM Fields

- 1. Search (text)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-001-search.png
- 2. Jump to (datetime-local)
  - DOM name: `date`
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-002-jump-to.png
- 3. Delivery (textarea)
  - DOM name: `settings_delivery`
  - Model field: Delivery / `delivery` / RichText
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-003-delivery.png
- 4. Rich text editor (presentation)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-004-rich-text-editor.png
- 5. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-005-p.png
- 6. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-006-p.png
- 7. Delivery (Reimagined) (textarea)
  - DOM name: `settings_pdp_delivery_content`
  - Model field: Delivery (Reimagined) / `pdp_delivery_content` / RichText
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-007-delivery-reimagined.png
- 8. Rich text editor (presentation)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-008-rich-text-editor.png
- 9. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-009-p.png
- 10. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-010-p.png
- 11. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-011-p.png
- 12. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-012-p.png
- 13. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-013-p.png
- 14. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-014-p.png
- 15. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-015-p.png
- 16. Returns (Reimagined) (textarea)
  - DOM name: `settings_pdp_returns_content`
  - Model field: Returns (Reimagined) / `pdp_returns_content` / RichText
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-016-returns-reimagined.png
- 17. Rich text editor (presentation)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-017-rich-text-editor.png
- 18. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-018-p.png
- 19. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-019-p.png
- 20. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-020-p.png
- 21. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-021-p.png
- 22. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-022-p.png
- 23. Unshippable Country Popup (textarea)
  - DOM name: `settings_unshippable_popup`
  - Model field: Unshippable Country Popup / `unshippable_popup` / RichText
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-023-unshippable-country-popup.png
- 24. Rich text editor (presentation)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-024-rich-text-editor.png
- 25. p (p)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-025-p.png
- 26. rxCompositionCutter0 (text)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-026-rxcompositioncutter0.png
- 27. rxCompositionCutter1 (text)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-027-rxcompositioncutter1.png
- 28. rxCompositionCutter2 (text)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-028-rxcompositioncutter2.png
- 29. rxCompositionCutter3 (text)
  - Screenshot: pages/001-cp-product-settings-admin-31616840/images/field-029-rxcompositioncutter3.png

### Source References

- provider: vendor/soho/products/src/Provider.php
- controller: vendor/soho/products/src/SettingsControllerAdmin.php
- view: vendor/soho/products/src/views/index.twig
- provider: src/Products/Provider.php
- model: src/Products/Model/Settings.php
- parent-model: vendor/soho/products/src/Model/Settings.php
- model-xml: src/Products/Model/Settings.xml
