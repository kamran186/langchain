INSERT INTO customers (id, organization_id, name, email, city, status) VALUES
('00000000-0000-4000-8000-000000000001','org-001','Ahmed Khan','ahmed@org1.example','Karachi','active'),
('00000000-0000-4000-8000-000000000002','org-001','Ayesha Ali','ayesha@org1.example','Lahore','active'),
('00000000-0000-4000-8000-000000000003','org-001','Bilal Shah','bilal@org1.example','Karachi','inactive'),
('00000000-0000-4000-8000-000000000004','org-002','Ahmed Khan','ahmed@org2.example','Lahore','inactive'),
('00000000-0000-4000-8000-000000000005','org-002','Sara Ahmed','sara@org2.example','Karachi','active'),
('00000000-0000-4000-8000-000000000006','org-002','Hina Noor','hina@org2.example','Lahore','active')
ON CONFLICT (id) DO NOTHING;
