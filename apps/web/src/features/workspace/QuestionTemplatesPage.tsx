import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VAGUE_CATEGORIES,
  VAGUE_CATEGORY_LABELS,
  type EffectiveQuestionTemplate,
  type VagueCategory,
} from '@froa/shared';
import { questionTemplateApi, workspaceApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';

type ScopeFilter = 'all' | VagueCategory;

const SCOPE_OPTIONS: { value: ScopeFilter; label: string }[] = [
  { value: 'all', label: '全部分类' },
  ...VAGUE_CATEGORIES.map((value) => ({ value, label: VAGUE_CATEGORY_LABELS[value] })),
];

const MODE_TAG: Record<EffectiveQuestionTemplate['mode'], { color: string; text: string }> = {
  inherited: { color: 'green', text: '继承家族' },
  override: { color: 'gold', text: '我已覆盖' },
  disabled: { color: 'default', text: '我已停用' },
};

/**
 * 追问话术 · 家族模板
 *
 * 一张表讲清三级关系：
 *   家族话术（整理者维护，新成员自动继承）
 *     ├─ 我没动过   → 继承家族
 *     ├─ 我改过     → 我已覆盖（随时恢复继承）
 *     └─ 我停用过   → 我已停用（随时恢复）
 * 家族模板本身也可以整体停用，停用后所有人都不再看到它。
 */
export function QuestionTemplatesPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { message } = AntApp.useApp();

  const [scope, setScope] = useState<ScopeFilter>('all');
  const [editingFamily, setEditingFamily] = useState<EffectiveQuestionTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [personalTarget, setPersonalTarget] = useState<EffectiveQuestionTemplate | null>(null);

  const workspace = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => workspaceApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const templates = useQuery({
    queryKey: ['question-templates', workspaceId],
    queryFn: () => questionTemplateApi.list(workspaceId!),
    enabled: Boolean(workspaceId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['question-templates', workspaceId] });

  const removeMutation = useMutation({
    mutationFn: (templateId: string) => questionTemplateApi.remove(workspaceId!, templateId),
    onSuccess: () => {
      message.success('家族话术已删除');
      void invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const toggleFamilyMutation = useMutation({
    mutationFn: ({ templateId, enabled }: { templateId: string; enabled: boolean }) =>
      questionTemplateApi.update(workspaceId!, templateId, { enabled }),
    onSuccess: (_data, variables) => {
      message.success(variables.enabled ? '家族话术已重新启用' : '家族话术已停用，成员不会再看到它');
      void invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const resetSettingMutation = useMutation({
    mutationFn: (templateId: string) => questionTemplateApi.resetSetting(workspaceId!, templateId),
    onSuccess: () => {
      message.success('已恢复继承家族话术');
      void invalidate();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  const canManage =
    workspace.data?.role === 'owner' || workspace.data?.role === 'editor';

  const data = (templates.data ?? []).filter(
    (template) => scope === 'all' || template.category === null || template.category === scope,
  );

  if (workspace.isLoading || templates.isLoading) return <Spin size="large" />;

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>追问话术 · 家族模板</h1>
          <div className="froa-hint">
            新人加入家庭时会自动继承整套话术；每个人都可以单独把某条换成自己的说法，或者临时停用，
            不影响其他家人。{'{原话}'} 会在追问时替换成条目原话，{'{称呼}'} 会替换成被问的人。
          </div>
        </div>
        {canManage && (
          <Button type="primary" onClick={() => setCreating(true)}>
            新建家族话术
          </Button>
        )}
      </div>

      <Segmented value={scope} onChange={(value) => setScope(value as ScopeFilter)} options={SCOPE_OPTIONS} />

      <Table
        rowKey="templateId"
        dataSource={data}
        pagination={false}
        rowClassName={(record) =>
          record.effectiveContent === null ? 'froa-template-row-off' : ''
        }
        columns={[
          {
            title: '分类',
            dataIndex: 'category',
            width: 110,
            render: (category: VagueCategory | null) =>
              category ? (
                <span className={`froa-tag-cat cat-${category}`}>{VAGUE_CATEGORY_LABELS[category]}</span>
              ) : (
                <Tag>通用</Tag>
              ),
          },
          {
            title: '话术标题',
            dataIndex: 'title',
            width: 200,
          },
          {
            title: '家族原话 / 我在用的话',
            render: (_, record) => (
              <div className="froa-stack" style={{ gap: 4 }}>
                {record.mode === 'override' && (
                  <Typography.Text>
                    <Tag color="gold" style={{ marginRight: 6 }}>
                      我的说法
                    </Tag>
                    {record.effectiveContent}
                  </Typography.Text>
                )}
                <Typography.Text
                  type={record.mode === 'override' ? 'secondary' : undefined}
                  delete={record.mode === 'disabled'}
                  style={record.mode === 'override' ? { fontSize: '0.85rem' } : undefined}
                >
                  {record.mode === 'override' ? '家族原文：' : ''}
                  {record.familyContent}
                </Typography.Text>
                {!record.familyEnabled && (
                  <Tag color="red" style={{ width: 'fit-content' }}>
                    家族已整体停用
                  </Tag>
                )}
                {record.mode === 'disabled' && record.reason && (
                  <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
                    停用原因：{record.reason}
                  </Typography.Text>
                )}
              </div>
            ),
          },
          {
            title: '我的状态',
            dataIndex: 'mode',
            width: 110,
            render: (mode: EffectiveQuestionTemplate['mode']) => (
              <Tag color={MODE_TAG[mode].color}>{MODE_TAG[mode].text}</Tag>
            ),
          },
          {
            title: '操作',
            width: 260,
            render: (_, record) => (
              <Space wrap size={4}>
                <Button size="small" onClick={() => setPersonalTarget(record)}>
                  {record.mode === 'inherited' ? '换成我的说法' : '编辑我的设置'}
                </Button>
                {record.mode !== 'inherited' && (
                  <Button size="small" onClick={() => resetSettingMutation.mutate(record.templateId)}>
                    恢复继承
                  </Button>
                )}
                {canManage && (
                  <>
                    <Button size="small" onClick={() => setEditingFamily(record)}>
                      编辑家族
                    </Button>
                    <Switch
                      size="small"
                      checked={record.familyEnabled}
                      checkedChildren="启用"
                      unCheckedChildren="停用"
                      loading={toggleFamilyMutation.isPending}
                      onChange={(enabled) =>
                        toggleFamilyMutation.mutate({ templateId: record.templateId, enabled })
                      }
                    />
                    <Popconfirm
                      title="删除这条家族话术？"
                      description="所有成员对它的个人设置也会一并删除。"
                      onConfirm={() => removeMutation.mutate(record.templateId)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button size="small" danger type="text">
                        删除
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />

      {creating && (
        <FamilyTemplateModal
          workspaceId={workspaceId!}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      )}

      {editingFamily && (
        <FamilyTemplateModal
          workspaceId={workspaceId!}
          template={editingFamily}
          onClose={() => setEditingFamily(null)}
          onSaved={() => {
            setEditingFamily(null);
            void invalidate();
          }}
        />
      )}

      {personalTarget && (
        <PersonalSettingModal
          workspaceId={workspaceId!}
          template={personalTarget}
          onClose={() => setPersonalTarget(null)}
          onSaved={() => {
            setPersonalTarget(null);
            void invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 家族话术的新建 / 编辑（整理者）                                     */
/* ------------------------------------------------------------------ */

interface FamilyModalProps {
  workspaceId: string;
  template?: EffectiveQuestionTemplate;
  onClose: () => void;
  onSaved: () => void;
}

function FamilyTemplateModal({ workspaceId, template, onClose, onSaved }: FamilyModalProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{
    category: VagueCategory | null;
    title: string;
    content: string;
  }>();

  const saveMutation = useMutation({
    mutationFn: async (values: {
      category: VagueCategory | null;
      title: string;
      content: string;
    }) => {
      if (template) {
        return questionTemplateApi.update(workspaceId, template.templateId, values);
      }
      return questionTemplateApi.create(workspaceId, values);
    },
    onSuccess: () => {
      message.success(template ? '家族话术已更新' : '家族话术已创建，成员下次打开追问台就能看到');
      onSaved();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <Modal
      open
      title={template ? `编辑家族话术：${template.title}` : '新建家族话术'}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={saveMutation.isPending}
      width={640}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          category: template?.category ?? null,
          title: template?.title ?? '',
          content: template?.familyContent ?? '',
        }}
        onFinish={(values) =>
          // Select 清空后拿到 undefined，而 PATCH 会把 undefined 理解为"不改"；
          // 显式归一化成 null 才能真正改回"通用话术"。
          saveMutation.mutate({ ...values, category: values.category ?? null })
        }
      >
        <Form.Item label="适用分类" name="category">
          <Select
            allowClear
            placeholder="不选 = 通用话术，任何条目下都出现"
            options={VAGUE_CATEGORIES.map((value) => ({
              value,
              label: VAGUE_CATEGORY_LABELS[value],
            }))}
          />
        </Form.Item>
        <Form.Item
          label="话术标题"
          name="title"
          rules={[{ required: true, message: '请填写标题，方便在列表里辨认' }]}
        >
          <Input maxLength={64} placeholder="例如：问用量 · 参照物换算法" />
        </Form.Item>
        <Form.Item
          label="话术内容"
          name="content"
          extra={'可用占位符：{原话} = 待澄清的原话；{称呼} = 被追问的家人。'}
          rules={[{ required: true, min: 2, message: '请填写话术内容' }]}
        >
          <Input.TextArea rows={4} maxLength={1000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* 个人设置：覆盖 / 临时停用（任何成员）                               */
/* ------------------------------------------------------------------ */

interface PersonalModalProps {
  workspaceId: string;
  template: EffectiveQuestionTemplate;
  onClose: () => void;
  onSaved: () => void;
}

function PersonalSettingModal({ workspaceId, template, onClose, onSaved }: PersonalModalProps) {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<'override' | 'disabled'>(
    template.mode === 'disabled' ? 'disabled' : 'override',
  );
  const [form] = Form.useForm<{ contentOverride: string; reason: string }>();

  const saveMutation = useMutation({
    mutationFn: (values: { contentOverride: string; reason: string }) => {
      if (mode === 'override') {
        return questionTemplateApi.override(workspaceId, template.templateId, values.contentOverride);
      }
      return questionTemplateApi.disable(workspaceId, template.templateId, values.reason);
    },
    onSuccess: () => {
      message.success(mode === 'override' ? '已换成你的说法，只对你一个人生效' : '已临时停用，随时可以恢复继承');
      onSaved();
    },
    onError: (error) => message.error(errorMessage(error)),
  });

  return (
    <Modal
      open
      title={`我的追问设置：${template.title}`}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText={mode === 'override' ? '保存我的说法' : '确认临时停用'}
      cancelText="取消"
      confirmLoading={saveMutation.isPending}
      width={640}
    >
      <Typography.Paragraph type="secondary">
        家族原文：{template.familyContent}
      </Typography.Paragraph>

      <Segmented
        block
        value={mode}
        onChange={(value) => setMode(value as 'override' | 'disabled')}
        options={[
          { value: 'override', label: '换成我的说法（只影响我）' },
          { value: 'disabled', label: '临时停用这条（只影响我）' },
        ]}
        style={{ marginBottom: 16 }}
      />

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          contentOverride: template.mode === 'override' ? template.effectiveContent ?? '' : '',
          reason: template.reason ?? '',
        }}
        onFinish={(values) => saveMutation.mutate(values)}
      >
        {mode === 'override' ? (
          <Form.Item
            label="我的话术"
            name="contentOverride"
            rules={[{ required: true, min: 2, message: '请填写你自己的话术' }]}
            extra="家族其他人看到的仍是家族原话，这里改的只属于你。"
          >
            <Input.TextArea rows={4} maxLength={1000} showCount />
          </Form.Item>
        ) : (
          <Form.Item
            label="停用原因（可选，留给以后的自己看）"
            name="reason"
            extra={'停用后这条不会出现在你的追问台；点「恢复继承」即可找回。'}
          >
            <Input maxLength={500} placeholder="例如：外婆不习惯这么正式的问法" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
