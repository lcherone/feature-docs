# Soho Home CP Feature Docs Agent Context

Generated: 2026-06-27T21:26:36.405Z

Use this file as the handoff for Codex to produce final operator documentation. Read the referenced controller, model, XML, and view files before finalising page purpose, field behaviour, validation, and side effects.

## Discount Permission Settings

- URL: https://dev.soho-home.local/cp/discount-permission-settings-admin
- Draft doc: pages/001-cp-discount-permission-settings-admin-71eed775/README.md
- Page screenshots: pages/001-cp-discount-permission-settings-admin-71eed775/images/page-desktop.png
- Field count: 2
- Controller: Soho\Ecom\CustomDiscount\Controller\PermissionSettingsAdminController (discount-permission-settings-admin)
- Controller file: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- Action method: indexAction (inherited or unresolved)
- Model: CustomDiscount_DiscountPermissionSettings => Soho\Ecom\CustomDiscount\Model\DiscountPermissionSettings
- Model file: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- Model XML: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml
- Model item prefix: discount_permission_settings

### DOM Fields

- 1. Search (text)
  - Screenshot: pages/001-cp-discount-permission-settings-admin-71eed775/images/field-001-search.png
- 2. Jump to (datetime-local)
  - DOM name: `date`
  - Screenshot: pages/001-cp-discount-permission-settings-admin-71eed775/images/field-002-jump-to.png

### Source References

- provider: vendor/soho/ecom/src/CustomDiscount/Provider.php
- controller: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- model: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- model-xml: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml

## Discount Permission Settings

- URL: https://dev.soho-home.local/cp/discount-permission-settings-admin/edit/new
- Draft doc: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/README.md
- Page screenshots: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/page-desktop.png
- Field count: 5
- Controller: Soho\Ecom\CustomDiscount\Controller\PermissionSettingsAdminController (discount-permission-settings-admin)
- Controller file: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- Action method: editAction (inherited or unresolved)
- Model: CustomDiscount_DiscountPermissionSettings => Soho\Ecom\CustomDiscount\Model\DiscountPermissionSettings
- Model file: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- Model XML: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml
- Model item prefix: discount_permission_settings

### DOM Fields

- 1. Search (text)
  - Screenshot: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/field-001-search.png
- 2. Jump to (datetime-local)
  - DOM name: `date`
  - Screenshot: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/field-002-jump-to.png
- 3. Role (select)
  - DOM name: `discount_permission_settings_role`
  - Model field: Role / `role` / SelectCallback
  - Screenshot: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/field-003-role.png
- 4. Max Discount Percentage (number)
  - DOM name: `discount_permission_settings_max_discount_percentage`
  - Model field: Max Discount Percentage / `max_discount_percentage` / Percentage
  - Screenshot: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/field-004-max-discount-percentage.png
- 5. Max Discount Amount optional (number)
  - DOM name: `discount_permission_settings_max_discount_amount`
  - Model field: Max Discount Amount / `max_discount_amount` / Currency
  - Screenshot: pages/002-cp-discount-permission-settings-admin-edit-new-1ad35cc5/images/field-005-max-discount-amount-optional.png

### Source References

- provider: vendor/soho/ecom/src/CustomDiscount/Provider.php
- controller: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- model: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- model-xml: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml

## Discount Permission Settings

- URL: https://dev.soho-home.local/cp/discount-permission-settings-admin/edit/1
- Draft doc: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/README.md
- Page screenshots: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/page-desktop.png
- Field count: 5
- Controller: Soho\Ecom\CustomDiscount\Controller\PermissionSettingsAdminController (discount-permission-settings-admin)
- Controller file: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- Action method: editAction (inherited or unresolved)
- Model: CustomDiscount_DiscountPermissionSettings => Soho\Ecom\CustomDiscount\Model\DiscountPermissionSettings
- Model file: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- Model XML: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml
- Model item prefix: discount_permission_settings

### DOM Fields

- 1. Search (text)
  - Screenshot: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/field-001-search.png
- 2. Jump to (datetime-local)
  - DOM name: `date`
  - Screenshot: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/field-002-jump-to.png
- 3. Role (select)
  - DOM name: `discount_permission_settings_role`
  - Model field: Role / `role` / SelectCallback
  - Screenshot: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/field-003-role.png
- 4. Max Discount Percentage (number)
  - DOM name: `discount_permission_settings_max_discount_percentage`
  - Model field: Max Discount Percentage / `max_discount_percentage` / Percentage
  - Screenshot: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/field-004-max-discount-percentage.png
- 5. Max Discount Amount optional (number)
  - DOM name: `discount_permission_settings_max_discount_amount`
  - Model field: Max Discount Amount / `max_discount_amount` / Currency
  - Screenshot: pages/003-cp-discount-permission-settings-admin-edit-1-4014e007/images/field-005-max-discount-amount-optional.png

### Source References

- provider: vendor/soho/ecom/src/CustomDiscount/Provider.php
- controller: vendor/soho/ecom/src/CustomDiscount/Controller/PermissionSettingsAdminController.php
- model: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.php
- model-xml: vendor/soho/ecom/src/CustomDiscount/Model/DiscountPermissionSettings.xml
