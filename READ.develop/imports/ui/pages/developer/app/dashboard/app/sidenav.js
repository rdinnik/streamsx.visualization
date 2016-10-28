import { Meteor } from 'meteor/meteor';
import _ from 'underscore/underscore';
import exportAppModal from './exportappmodal.html';

import {Users} from '/imports/api/users';
import {Apps} from '/imports/api/apps';
import {Dashboards} from '/imports/api/dashboards';
import {Visualizations} from '/imports/api/visualizations';
import {DataSets} from '/imports/api/datasets';

export const appSideNavCtrl = ['$scope', '$reactive', '$state', 'readState', '$q', '$uibModal',
function ($scope, $reactive, $state, readState, $q, $uibModal) {
  $reactive(this).attach($scope);
  let self = this;

  this.helpers({
    user: () => Users.findOne({}),
    items: () => Apps.find({}).fetch(),
    item: () => Apps.findOne({_id: self.user.selectedIds.appId}),
    exportedItem: () => {
      let exportedApp = {
        version: "0.5.0",
        app: Apps.findOne({_id: self.getReactively('user.selectedIds.appId')}),
        dashboards: Dashboards.find({appId: self.getReactively('user.selectedIds.appId')}).fetch(),
        dataSets: DataSets.find({appId: self.getReactively('user.selectedIds.appId')}).fetch(),
        visualizations: Visualizations.find({appId: self.getReactively('user.selectedIds.appId')}).fetch(),
      };
      // instead of alert, we want to use ngclipboard to copy stringified json to clipboard here...
      return exportedApp;
    },
    itemsControl: () => {
      return {
        itemType: "App",
        clonable: false,
        selectedId: self.getReactively('user.selectedIds.appId'),
        selectedItem: Apps.findOne({_id: self.getReactively('user.selectedIds.appId')}),
        exportable: () => ! _.isUndefined(self.getReactively('user.selectedIds.appId')),
        exportItem: () => {
          let modalInstance = $uibModal.open({
            resolve: {
              exportedItem: function() {
                return self.getReactively('exportedItem');
              }
            },
            controller: ['$scope', 'exportedItem', '$uibModalInstance',
            function($scope, exportedItem, $uibModalInstance) {
              $scope.exportedItem = JSON.stringify(exportedItem, undefined, 2);
              this.cancel = function() {
                $uibModalInstance.dismiss('cancel');
              };
              $scope.copied = false;
              this.copy = function() {
                $scope.copied = true;
              }
            }],
            controllerAs: 'modalCtrl',
            size: 'lg',
            templateUrl: exportAppModal
          });
//          alert(JSON.stringify(self.getReactively('exportedItem')));
        },
        creatable: () => true,
        switchItem: (selectedId) => {
          self.user.selectedIds.appId = selectedId;
          // reset all deferredPromises...
          readState.deferredDashboards = $q.defer();
          readState.deferredDataSets = $q.defer();
          readState.deferredVisualizations = $q.defer();
          // now we're ready to update and resubscribe in readCtrl
          Meteor.call('user.update', self.user, (err, res) => {if (err) alert(err);}); //update user
          $state.reload('read.developer');
        },
        createItem: () => {
          Meteor.call('app.create', {
            userId: 'guest',
            name: self.itemsControl.itemType + self.items.length,
            private: true,
            readOnly: false
          }, (err, res) => {
            if (err) alert(err);
            else {
              self.itemsControl.switchItem(res);
            }
          });
        }
      }
    }
  });

  this.itemControls = {
    itemType: 'App',
    validItem: () => true,
    renameItem: (newName) => {
      self.item.name = newName;
      self.updateDatabase(self.item);
    },
    updateItem: () => {
      self.updateDatabase(self.item);
      $state.reload('read.developer.app.dashboard');
    },
    deletable: () => true,
    deleteItem: () => {
      // start by deleting visualizations
      Visualizations.find({appId: self.item._id}).fetch().forEach(visualization => {
        Meteor.call('visualization.delete', visualization._id, (err, res) => {if (err) alert(err);});
      });
      // and dashboards
      Dashboards.find({appId: self.item._id}).fetch().forEach(dashboard => {
        Meteor.call('dashboard.delete', dashboard._id, (err, res) => {if (err) alert(err);});
      });
      // and datasets
      DataSets.find({appId: self.item._id}).fetch().forEach(dataSet => {
        Meteor.call('dataSet.delete', dataSet._id, (err, res) => {if (err) alert(err);});
      });
      // and then delete app...
      Meteor.call('app.delete', self.item._id, (err, res) => {
        if (err) alert(err);
        else {
          let newSelectedItem = _.find(self.items, x => (x._id !== self.user.selectedIds.appId));
          // we are updating user but avoiding update of items (or anything else here);
          if (newSelectedItem) self.user.selectedIds.appId = newSelectedItem._id;
          else delete self.user.selectedIds['appId'];
          Meteor.call('user.update', self.user, (err, res) => {if (err) alert(err);});
          $state.reload('read.developer.app.dashboard');
        }
      });
    }
  };

  // update database
  this.updateDatabase = (val) => {
    Meteor.call('app.update', val._id, val, (err, res) => {
      if (err) alert(err);
    });
  };

}];